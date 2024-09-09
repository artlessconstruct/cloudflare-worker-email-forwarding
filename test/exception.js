import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from 'vitest';
import escape from 'regexp.escape';

// Specifing the file allows vitest to detect changes in the source files in watch mode:
import worker, { FIXED, DEFAULTS } from "./worker.js";

// Exceptional conditions:
// - forward mock can throw exceptions
// - Destinations can be unverified
// - Pathological conditions sought 
//
describe('Email forwarding: exceptional conditions', () => {
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

    describe('One destination, one failure', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user@email.com',
        };

        it.each([
            ['user1@domain.com',
                environment.DESTINATION,
                serviceErrorMessage,
                serviceErrorRegExp
            ],
        ])('%s fowards to %s, catches \'%s\', rethrows', async (to, dest, errorMessage, errorRegExp) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValue(new Error(errorMessage));
            const forward = vi.spyOn(message, 'forward');

            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(errorRegExp);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(1);
        });
    });

    describe('One destination, one unverified', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1@email.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                unverifiedDestinationErrorMessage,
                environment.REJECT_TREATMENT
            ],
        ])('%s forwards to %s, catches \'%s\', direct rejects \'%s\'', async (to, dest1, error1Message, reason) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValue(new Error(error1Message));
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(1);
            expect(reject).toHaveBeenCalledWith(reason);
            expect(reject).toHaveBeenCalledTimes(1);
        });
    });

    describe('One destination, reject destination unverified', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1@email.com',
            REJECT_TREATMENT: 'reject@email.com',
        };
        it.each([
            ['user2@domain.com',
                environment.REJECT_TREATMENT.removeWhitespace(),
                unverifiedDestinationErrorMessage,
                FIXED.prepend(DEFAULTS.REJECT_TREATMENT,
                    [{ test: FIXED.startsWithNonAlphanumericRegExp, prepend: 'user2' }]
                )
            ],
        ])('%s reject forwards to %s, catches \'%s\', direct rejects with fallback to default reason \'%s\'', async (to, dest1, error1Message, reason) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValue(new Error(error1Message));
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
            expect(forward).toHaveBeenCalledTimes(1);
            expect(reject).toHaveBeenCalledWith(reason);
            expect(reject).toHaveBeenCalledTimes(1);
        });
    });

    describe('Two destinations, one failure', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1a@email.com, user1b@email.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                serviceErrorMessage,
                environment.DESTINATION.removeWhitespace().split(',')[1],
                overallFailureErrorMessage,
            ],
        ])('%s forwards to %s, catches \'%s\', forwards to %s, throws \'%s\'', async (to, dest1, error1Message, dest2, error2Message, error2RegExp) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(error1Message))
                .mockResolvedValueOnce();
            const forward = vi.spyOn(message, 'forward');
            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(error2RegExp);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                environment.DESTINATION.removeWhitespace().split(',')[1],
                serviceErrorMessage,
                overallFailureErrorMessage,
                overallFailureErrorRegExp
            ],
        ])('%s forwards to %s, forwards to %s, catches \'%s\', throws \'%s\'', async (to, dest1, dest2, error1Message, error2Message, error2RegExp) => {
            message.to = to;
            message.forward = vi.fn()
                .mockResolvedValueOnce()
                .mockRejectedValueOnce(new Error(error1Message));
            const forward = vi.spyOn(message, 'forward');
            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(error2RegExp);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });

    describe('Two destinations, one unverified, one failure', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1a@email.com, user1b@email.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                unverifiedDestinationErrorMessage,
                environment.DESTINATION.removeWhitespace().split(',')[1],
                serviceErrorMessage,
                overallFailureErrorRegExp,
            ],
        ])('%s forwards to %s, catches \'%s\', forwards to %s, catches \'%s\', throws \'%s\'', async (to, dest1, error1Message, dest2, error2Message, error3RegExp) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(error1Message))
                .mockRejectedValueOnce(new Error(error2Message));
            const forward = vi.spyOn(message, 'forward');
            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(error3RegExp);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });

        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                serviceErrorMessage,
                environment.DESTINATION.removeWhitespace().split(',')[1],
                unverifiedDestinationErrorMessage,
                overallFailureErrorRegExp,
            ],
        ])('%s forwards to %s, catches \'%s\', forwards to %s, catches \'%s\', throws \'%s\'', async (to, dest1, error1Message, dest2, error2Message, error3RegExp) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(error1Message))
                .mockRejectedValueOnce(new Error(error2Message));
            const forward = vi.spyOn(message, 'forward');
            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(error3RegExp);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });

    describe('Two destinations, one unverified', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1a@email.com, user1b@email.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                unverifiedDestinationErrorMessage,
                environment.DESTINATION.removeWhitespace().split(',')[1],
            ],
        ])('%s forwards to %s, catches \'%s\', forwards to %s, no rethrow', async (to, dest1, error1Message, dest2) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(error1Message))
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
                environment.DESTINATION.removeWhitespace().split(',')[0],
                environment.DESTINATION.removeWhitespace().split(',')[1],
                unverifiedDestinationErrorMessage,
            ],
        ])('%s forwards to %s, forwards to %s, catches \'%s\', no rethrow', async (to, dest1, dest2, error2Message) => {
            message.to = to;
            message.forward = vi.fn()
                .mockResolvedValueOnce()
                .mockRejectedValueOnce(new Error(error2Message));
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });

    describe('Two destinations, both unverified, or failures', () => {
        const environment = {
            ...TEST,
            USERS: 'user1',
            DESTINATION: 'user1a@email.com, user1b@email.com',
        };
        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                unverifiedDestinationErrorMessage,
                environment.DESTINATION.removeWhitespace().split(',')[1],
                environment.REJECT_TREATMENT
            ],
        ])('%s forwards to %s, catches \'%s\', forwards to %s, catches same, direct rejects \'%s\'', async (to, dest1, error1Message, dest2, reason) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(error1Message))
                .mockRejectedValueOnce(new Error(error1Message));
            const forward = vi.spyOn(message, 'forward');
            await worker.email(message, environment, context);
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
            expect(reject).toHaveBeenCalledWith(reason);
            expect(reject).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['user1@domain.com',
                environment.DESTINATION.removeWhitespace().split(',')[0],
                serviceErrorMessage,
                environment.DESTINATION.removeWhitespace().split(',')[1],
                serviceErrorMessage,
                overallFailureErrorMessage,
                overallFailureErrorRegExp,
            ],
        ])('%s forwards to %s, catches \'%s\', forwards to %s, catches same, throws \'%s\'', async (to, dest1, error1Message, dest2, error3Message, error3RegExp) => {
            message.to = to;
            message.forward = vi.fn()
                .mockRejectedValueOnce(new Error(error1Message))
                .mockRejectedValueOnce(new Error(error1Message));
            const forward = vi.spyOn(message, 'forward');
            await expect(() => worker.email(message, environment, context)).rejects
                .toThrowError(error3RegExp);
            expect(reject).not.toHaveBeenCalled();
            expect(forward).toHaveBeenCalledWith(dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledWith(dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            expect(forward).toHaveBeenCalledTimes(2);
        });
    });
});