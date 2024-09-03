import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

// Specifing the file allows vitest to detect changes in the source files in watch mode:
import worker, { DEFAULTS } from "./worker.js";

describe('Email Subaddressing', () => {
    const context = {};
    const TEST = {
        ...DEFAULTS,
        USE_STORED_USER_CONFIGURATION: "true",
        USE_STORED_ADDRESS_GLOBAL_CONFIGURATION: "true",
        USE_STORED_FORMAT_GLOBAL_CONFIGURATION: "true",
        USE_STORED_FORWARD_RETRY_GLOBAL_CONFIGURATION: "true",
        USE_STORED_HEADER_GLOBAL_CONFIGURATION: "true",
        REJECT_TREATMENT: "Invalid recipient"
    };
    const message = {
        from: 'random@internet.com',
        forward: (to, headers) => JSON.stringify({ to, headers }),
        setReject: (reason) => reason,
        // ...
        to: undefined,
        // ---
        headers: {},
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

    describe('Defaults', () => {
        const environment = { ...TEST };

        it.each([
            ['user1@domain.com', TEST.REJECT_TREATMENT],
            ['user1+subA@domain.com', TEST.REJECT_TREATMENT],
            ['user2@domain.com', TEST.REJECT_TREATMENT],
            ['user2+subA@domain.com.com', TEST.REJECT_TREATMENT],
            ['user2+subB@domain.com', TEST.REJECT_TREATMENT],
        ])('%s should reject with "%s"', async (to, reason) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).not.toHaveBeenCalled();
            expect(reject).toHaveBeenCalledWith(reason);
            expect(reject).toHaveReturnedTimes(1);
        });
    });

    describe('Environment variables', () => {

        describe('Single user, any subaddress, single destination, reject', () => {
            const environment = {
                ...TEST,
                USERS: 'user1',
                DESTINATION: 'user@email.com'
            };

            it.each([
                ['user1@domain.com', environment.DESTINATION],
                ['user1+subA@domain.com', environment.DESTINATION],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user2@domain.com', TEST.REJECT_TREATMENT],
                ['user2+subA@domain.com', TEST.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });

        describe('Multiple users, any subaddress, domain destination, fail-forward', () => {
            const environment = {
                ...TEST,
                USERS: 'user1,user2',
                DESTINATION: '@email.com',
                REJECT_TREATMENT: '+spam@email.com'
            };

            it.each([
                ['user1@domain.com', `user1${environment.DESTINATION}`],
                ['user1+subA@domain.com', `user1${environment.DESTINATION}`],
                ['user2@domain.com', `user2${environment.DESTINATION}`],
                ['user2+subA@domain.com', `user2${environment.DESTINATION}`],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            });

            it.each([
                ['user3@domain.com', `user3${environment.REJECT_TREATMENT}`],
                ['user3+subA@domain.com', `user3${environment.REJECT_TREATMENT}`],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(1);
            });
        });

        describe('Any user, specific subaddresses, single destination, custom reject', () => {
            const environment = {
                ...TEST,
                USERS: '*',
                SUBADDRESSES: 'subA, subB',
                DESTINATION: 'user@email.com',
                REJECT_TREATMENT: 'No such recipient'
            };

            it.each([
                ['user1@domain.com', environment.DESTINATION],
                ['user1+subA@domain.com', environment.DESTINATION],
                ['user1+subB@domain.com', environment.DESTINATION],
                ['userN@domain.com', environment.DESTINATION],
                ['userN+subA@domain.com', environment.DESTINATION],
                ['userN+subB@domain.com', environment.DESTINATION],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
            });

            it.each([
                ['userN+subC@domain.com', environment.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });

        describe('..., custom subaddressing separator character, custom forward header', () => {
            const environment = {
                ...TEST,
                USERS: 'user1',
                DESTINATION: 'user@email.com',
                FORMAT_LOCAL_PART_SEPARATOR: '--',
                REJECT_TREATMENT: 'user+spam@email.com',
                CUSTOM_HEADER: 'X-CUSTOM'
            };

            it.each([
                ['user1@domain.com', environment.DESTINATION],
                ['user1--subA@domain.com', environment.DESTINATION],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [environment.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user1+subA@domain.com', environment.REJECT_TREATMENT],
                ['user2@domain.com', environment.REJECT_TREATMENT],
                ['user2--subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [environment.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(1);
            });
        });
    });

    describe('KV globals', () => {

        describe('Single user, any subaddress, single destination, reject', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1');
            MAP.set('@DESTINATION', 'user@email.com');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', MAP.get('@DESTINATION')],
                ['user1+subA@domain.com', MAP.get('@DESTINATION')],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user2@domain.com', TEST.REJECT_TREATMENT],
                ['user2+subA@domain.com', TEST.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });

        describe('Multiple users, any subaddress, domain destination, fail-forward', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1,user2');
            MAP.set('@DESTINATION', '@email.com');
            MAP.set('@REJECT_TREATMENT', '+spam@email.com');
            MAP.set('user3', '');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', `user1${MAP.get('@DESTINATION')}`],
                ['user1+subA@domain.com', `user1${MAP.get('@DESTINATION')}`],
                ['user2@domain.com', `user2${MAP.get('@DESTINATION')}`],
                ['user2+subA@domain.com', `user2${MAP.get('@DESTINATION')}`],
                ['user3+subA@domain.com', `user3${MAP.get('@DESTINATION')}`],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user4@domain.com', `user4${MAP.get('@REJECT_TREATMENT')}`],
                ['user4+subA@domain.com', `user4${MAP.get('@REJECT_TREATMENT')}`],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(1);
            });
        });

        describe('Any user, specific subaddresses, single destination, custom reject', () => {
            const MAP = new Map();
            MAP.set('@USERS', '*');
            MAP.set('@SUBADDRESSES', 'subA, subB');
            MAP.set('@DESTINATION', 'user@email.com');
            MAP.set('@REJECT_TREATMENT', 'No such recipient');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', MAP.get('@DESTINATION')],
                ['user1+subA@domain.com', MAP.get('@DESTINATION')],
                ['user1+subB@domain.com', MAP.get('@DESTINATION')],
                ['userN@domain.com', MAP.get('@DESTINATION')],
                ['userN+subA@domain.com', MAP.get('@DESTINATION')],
                ['userN+subB@domain.com', MAP.get('@DESTINATION')],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['userN+subC@domain.com', MAP.get('@REJECT_TREATMENT')],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });

        describe('..., custom subaddressing separator character, custom forward header', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1');
            MAP.set('@DESTINATION', 'user@email.com');
            MAP.set('@FORMAT_LOCAL_PART_SEPARATOR', '--');
            MAP.set('@REJECT_TREATMENT', 'user+spam@email.com');
            MAP.set('@CUSTOM_HEADER', 'X-Custom');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', MAP.get('@DESTINATION')],
                ['user1--subA@domain.com', MAP.get('@DESTINATION')],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [MAP.get('@CUSTOM_HEADER')]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user1+subA@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user2@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user2--subA@domain.com', MAP.get('@REJECT_TREATMENT')],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [MAP.get('@CUSTOM_HEADER')]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(1);
            });
        });

    });

    describe('KV users', () => {

        describe('Multiple users, any subaddress, user destination, reject', () => {
            const MAP = new Map();
            MAP.set('user1', 'user1@email.com');
            MAP.set('user2', 'user2@email.com;user2+spam@email.com');
            MAP.set('user3', '');
            const environment = {
                ...TEST,
                DESTINATION: 'user3@email.com',
                MAP
            };

            it.each([
                ['user1@domain.com', MAP.get('user1').split(';')[0]],
                ['user1+subA@domain.com', MAP.get('user1').split(';')[0]],
                ['user2@domain.com', MAP.get('user2').split(';')[0]],
                ['user2+subA@domain.com', MAP.get('user2').split(';')[0]],
                ['user3@domain.com', environment.DESTINATION],
                ['user3+subA@domain.com', environment.DESTINATION],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user4@domain.com', TEST.REJECT_TREATMENT],
                ['user4+subA@domain.com', TEST.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });

        describe('Multiple users, user subaddresses, user destination, mixed error handling', () => {
            const MAP = new Map();
            MAP.set('user1', 'user1@email.com');
            MAP.set('user1+', 'subA');
            MAP.set('user2', 'user2@email.com;user2+spam@email.com');
            MAP.set('user2+', 'subA, subB');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', MAP.get('user1').split(';')[0]],
                ['user1+subA@domain.com', MAP.get('user1').split(';')[0]],
                ['user2@domain.com', MAP.get('user2').split(';')[0]],
                ['user2+subA@domain.com', MAP.get('user2').split(';')[0]],
                ['user2+subB@domain.com', MAP.get('user2').split(';')[0]],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user2+subC@domain.com', MAP.get('user2').split(';')[1]],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user1+subB@domain.com', TEST.REJECT_TREATMENT],
                ['user3@domain.com', TEST.REJECT_TREATMENT],
                ['user3+subA@domain.com', TEST.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });
    });

    describe('Mixed configurations', () => {

        describe('KV globals override environment variables', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user2');
            MAP.set('@SUBADDRESSES', 'subA, subB');
            MAP.set('@DESTINATION', 'user2@email.com');
            const environment = {
                ...TEST,
                USERS: 'user1',
                DESTINATION: 'user1@email.com',
                FORMAT_LOCAL_PART_SEPARATOR: '--',
                REJECT_TREATMENT: 'No such recipient',
                CUSTOM_HEADER: 'X-CUSTOM',
                MAP
            };

            it.each([
                ['user1@domain.com', environment.REJECT_TREATMENT],
                ['user1--subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });

            it.each([
                ['user2@domain.com', MAP.get('@DESTINATION')],
                ['user2--subA@domain.com', MAP.get('@DESTINATION')],
                ['user2--subB@domain.com', MAP.get('@DESTINATION')],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [environment.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user2--subC@domain.com', environment.REJECT_TREATMENT],
                ['user2+subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });

        describe('KV users override KV globals', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1');
            MAP.set('@SUBADDRESSES', 'subA, subB');
            MAP.set('@DESTINATION', 'user1@email.com');
            MAP.set('@REJECT_TREATMENT', 'No such recipient');
            MAP.set('user2', 'user2@email.com');
            MAP.set('user2+', 'subC');
            MAP.set('user3', 'user3@email.com;user3+spam@email.com');
            MAP.set('user4', 'user4@email.com');
            MAP.set('user4+', '*');
            MAP.set('user5', 'user5@email.com');
            MAP.set('user5+', '+*');
            MAP.set('user6', 'user6@email.com');
            MAP.set('user6+', '');
            MAP.set('user7', 'user7@email.com');
            MAP.set('user7+', '+');
            MAP.set('user8', 'user8@email.com');
            MAP.set('user8+', '+ subC, subD');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', MAP.get('@DESTINATION')],
                ['user1+subA@domain.com', MAP.get('@DESTINATION')],
                ['user1+subB@domain.com', MAP.get('@DESTINATION')],
                ['user2@domain.com', MAP.get('user2')],
                ['user2+subC@domain.com', MAP.get('user2')],
                ['user3@domain.com', MAP.get('user3').split(';')[0]],
                ['user3+subA@domain.com', MAP.get('user3').split(';')[0]],
                ['user3+subB@domain.com', MAP.get('user3').split(';')[0]],
                ['user4@domain.com', MAP.get('user4')],
                ['user4+subC@domain.com', MAP.get('user4')],
                ['user4+subD@domain.com', MAP.get('user4')],
                ['user5+subC@domain.com', MAP.get('user5')],
                ['user5+subD@domain.com', MAP.get('user5')],
                ['user6@domain.com', MAP.get('user6')],
                ['user8+subC@domain.com', MAP.get('user8')],
                ['user8+subD@domain.com', MAP.get('user8')],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user1+subC@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user2+subA@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user2+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user5@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user6+subA@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user6+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user7@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user7+subA@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user7+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user8@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user8+subA@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user8+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });

            it.each([
                ['user3+subC@domain.com', MAP.get('user3').split(';')[1]],
            ])('%s should reject forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(1);
            });
        });

        describe('KV user destination of empty string defaulting to global destination', () => {
            const MAP = new Map();
            MAP.set('@DESTINATION', 'default@email.com');
            MAP.set('@REJECT_TREATMENT', 'No such recipient');
            MAP.set('user1', '');
            MAP.set('user1+', 'subA');
            MAP.set('user2', ' ');
            MAP.set('user2+', 'subA');
            MAP.set('user3', ' ; ');
            MAP.set('user3+', 'subA');
            MAP.set('user4', ' ; No such user  ');
            MAP.set('user4+', 'subA');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', MAP.get('@DESTINATION')],
                ['user1+subA@domain.com', MAP.get('@DESTINATION')],
                ['user2@domain.com', MAP.get('@DESTINATION')],
                ['user2+subA@domain.com', MAP.get('@DESTINATION')],
                ['user3@domain.com', MAP.get('@DESTINATION')],
                ['user3+subA@domain.com', MAP.get('@DESTINATION')],
                ['user4@domain.com', MAP.get('@DESTINATION')],
                ['user4+subA@domain.com', MAP.get('@DESTINATION')],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(1);
            });

            it.each([
                ['user1+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user2+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user3+subB@domain.com', MAP.get('@REJECT_TREATMENT')],
                ['user4+subB@domain.com', MAP.get('user4').split(';')[1].trim()],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
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
                expect(forward).toHaveBeenNthCalledWith(1, dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveBeenNthCalledWith(2, dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(2);
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
                expect(forward).toHaveBeenNthCalledWith(1, dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveBeenNthCalledWith(2, dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(2);
            });
        });

        describe('KV destination validation', () => {
            const MAP = new Map();
            MAP.set('@SUBADDRESSES', 'subA');
            MAP.set('@DESTINATION', 'user1@email.com');
            MAP.set('@REJECT_TREATMENT', 'No such recipient');
            MAP.set('user1', ',user1a@email.com  , missingdomain, , missing domain, user1b @email.com,  user1a@email.com; '
                + 'missing domain,missingdomain , user1+spam1a@email.com, user1+spam1b @email.com, user1+spam1a@email.com');
            const environment = { ...TEST, MAP };

            const validEmailAddressRegex = new RegExp(TEST.FORMAT_VALID_EMAIL_ADDRESS_REGEX);
            const expectedAcceptDestinations = MAP.get('user1').split(';')[0].removeWhitespace().split(',')
                .filter(item => validEmailAddressRegex.test(item));
            const expectedRejectDestinations = MAP.get('user1').split(';')[1].removeWhitespace().split(',')
                .filter(item => validEmailAddressRegex.test(item));
            it.each([
                ['user1+subA@domain.com',
                    expectedAcceptDestinations[0],
                    expectedAcceptDestinations[1]
                ],
            ])('%s should forward to %s and %s', async (to, dest1, dest2) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenNthCalledWith(1, dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveBeenNthCalledWith(2, dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveReturnedTimes(2);
            });

            it.each([
                ['user1+subB@domain.com',
                    expectedRejectDestinations[0],
                    expectedRejectDestinations[1]
                ],
            ])('%s should reject forward to %s and %s', async (to, dest1, dest2) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(reject).not.toHaveBeenCalled();
                expect(forward).toHaveBeenNthCalledWith(1, dest1, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveBeenNthCalledWith(2, dest2, new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveReturnedTimes(2);
            });
        });

        describe('Prepending of local-part to failure reason', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1');
            MAP.set('@SUBADDRESSES', 'subA');
            MAP.set('@DESTINATION', 'user1@email.com');
            MAP.set('@REJECT_TREATMENT', ' : No such recipient ');
            MAP.set('user1', 'user1@email.com;  ');
            MAP.set('user2', 'user2@email.com;   : Invalid recipient    ');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1+subB@domain.com', 'user1+subB' + MAP.get('@REJECT_TREATMENT').trim()],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });

            it.each([
                ['user2+subB@domain.com', 'user2+subB' + MAP.get('user2').split(';')[1].trim()],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(reject).toHaveBeenCalledWith(reason);
                expect(reject).toHaveReturnedTimes(1);
            });
        });
    });
});
