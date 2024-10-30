import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from 'vitest';
import escape from 'regexp.escape';

// Specifing the file allows vitest to detect changes in the source files in watch mode:
import worker, { FIXED, DEFAULTS } from "./worker.js";

// Normal conditions:
// - message.forward mock doesn't throw any exceptions
// - this implies that no validly formatted destinations are unverified
// - avoiding pathological conditions
//  
describe('Email forwarding: multidestination', () => {
    const context = {};
    const TEST = {
        ...DEFAULTS,
        REJECT_TREATMENT: "Invalid recipient"
    };
    const message = {
        from: 'random@internet.com',
        forward: (to, headers) => JSON.stringify({ to, headers }),
        setReject: (reason) => reason,
        to: undefined,
        headers: {
            get: (headerName) => {
                const mockHeaders = {
                    'Message-ID': 'h9MTV7vNalV3',
                    'Date': 'Wed, 30 Oct 2024 15:30:00 +0000'
                };
                return mockHeaders[headerName];
            }
        },
        raw: null,
        rawSize: null,
    };
    const forward = vi.spyOn(message, 'forward');
    const reject = vi.spyOn(message, 'setReject');

    beforeEach(async () => {
        message.to = null;
    });

    afterEach(async () => {
        vi.clearAllMocks();
        vi.resetAllMocks();
    });

    describe('KV multiple destinations', () => {
        const MAP = new Map();
        MAP.set('@SUBADDRESSES', 'subA');
        MAP.set('@REJECT_TREATMENT', 'No such recipient');
        MAP.set('user1', 'user1a@email.com, user1b@email.com; '
            + 'user1+spam1@email.com, user1+spam2@email.com');
        const environment = { ...TEST, MAP };

        it.each([
            ['user1+subA@domain.com',
                MAP.get('user1').split(';')[0].removeWhitespace().split(',')[0],
                MAP.get('user1').split(';')[0].removeWhitespace().split(',')[1]
            ],
        ])('%s should forward to %s and %s', async (to, dest1, dest2) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });

        it.each([
            ['user1+subB@domain.com',
                MAP.get('user1').split(';')[1].split(',')[0].removeWhitespace(),
                MAP.get('user1').split(';')[1].split(',')[1].removeWhitespace()
            ],
        ])('%s should reject forward to %s and %s', async (to, dest1, dest2) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });
});