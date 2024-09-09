import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from 'vitest';
import escape from 'regexp.escape';

// Specifing the file allows vitest to detect changes in the source files in watch mode:
import worker, { FIXED, DEFAULTS } from "./worker.js";

// Failover conditions:
//
describe('Email forwarding: failover conditions', () => {
    const context = {};
    const TEST = {
        ...DEFAULTS,
        USE_STORED_ADDRESS_CONFIGURATION: "true",
        USE_STORED_USER_CONFIGURATION: "true",
        USE_STORED_ERROR_MESSAGE_CONFIGURATION: "true",
        USE_STORED_FORMAT_CONFIGURATION: "true",
        USE_STORED_HEADER_CONFIGURATION: "true",
        REJECT_TREATMENT: "Invalid recipient"
    };
    const message = {
        from: 'random@internet.com',
        forward: undefined,
        setReject: (reason) => reason,
        // ...
        to: undefined,
        // ---
        headers: {},
        raw: null,
        rawSize: null,
    };
    const reject = vi.spyOn(message, 'setReject');

    beforeEach(async () => {
        message.to = null;
        message.forward = null;
    });

    afterEach(async () => {
        vi.clearAllMocks();
        vi.resetAllMocks();
    });

    function entireMatchRegExp(s) { return new RegExp('^' + escape(s) + '$') };
    const serviceErrorMessage = 'Service failure';
    const serviceErrorRegExp = entireMatchRegExp(serviceErrorMessage);
    const unverifiedDestinationErrorMessage = TEST.UNVERIFIED_DESTINATION_ERROR_MESSAGE;
    const overallFailureErrorMessage = FIXED.overallFailureErrorMessagePrefix;
    const overallFailureErrorRegExp = new RegExp(`^${escape(overallFailureErrorMessage)}`);

    describe('1 FOD, no failure,', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1@email1.com:user1@email2.com',
        };

        it.each([
            ['user1@domain.com',
                environment.DESTINATION.split(':')[0],
                environment.DESTINATION.split(':')[1]
            ],
        ])('%s fowards to %s, ', async (to, dest1, errorMessage, dest2) => {
            message.to = to;
            message.forward = vi.fn()
                .mockResolvedValue('forward');
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(1);
        });
    });

    describe('1 FOD, 1 failure', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1@email1.com:user1@email2.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.split(':')[0],
                serviceErrorMessage,
                environment.DESTINATION.split(':')[1]
            ],
        ])('%s fowards to %s, catches \'%s\', forwards to %s', async (to, dest1, errorMessage, dest2) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(errorMessage))
                .mockResolvedValueOnce();
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });

    describe('1 FOD, 2 SD, 1 or 2 unverfied', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1@email1.com:user1@email2.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.split(':')[0],
                unverifiedDestinationErrorMessage,
                environment.DESTINATION.split(':')[1]
            ],
        ])('%s fowards to %s, catches \'%s\', forwards to %s', async (to, dest1, errorMessage, dest2) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(errorMessage))
                .mockResolvedValueOnce();
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.split(':')[0],
                unverifiedDestinationErrorMessage,
                environment.DESTINATION.split(':')[1],
                environment.REJECT_TREATMENT
            ],
        ])('%s fowards to %s, catches \'%s\', forwards to %s, catches same, direct rejects \'%s\'', async (to, dest1, errorMessage, dest2, reason) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(errorMessage))
                .mockRejectedValueOnce(new Error(errorMessage));
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(reject).toHaveBeenCalledWith(reason);
            expect(reject).toHaveBeenCalledTimes(1);
        });
    });

    describe('2 FODs, 1 failure', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1a@email1.com:user1a@email2.com,user1b@email3.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.split(',')[0].split(':')[0],
                serviceErrorMessage,
                environment.DESTINATION.split(',')[0].split(':')[1],
                environment.DESTINATION.split(',')[1]
            ],
        ])('%s fowards to %s, catches \'%s\', forwards to %s, forwards to %s', async (to, dest1, errorMessage, dest2, dest3) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(errorMessage))
                .mockResolvedValueOnce();
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest3, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(3);
        });
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.split(',')[0].split(':')[0],
                environment.DESTINATION.split(',')[0].split(':')[1],
                environment.DESTINATION.split(',')[1],
                serviceErrorMessage,
                overallFailureErrorMessage,
                overallFailureErrorRegExp
            ],
        ])('%s fowards to %s, not to %s, forwards to %s catches \'%s\' throws \'%s\'', async (to, dest1, dest2, dest3, errorMessage, errorMessageRegex) => {
            message.to = to;
            message.forward = vi.fn()
                .mockResolvedValueOnce()
                .mockRejectedValueOnce(new Error(errorMessage));
            const forward = vi.spyOn(message, 'forward');
            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(errorMessageRegex);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest3, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });
});