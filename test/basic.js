import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from 'vitest';
import escape from 'regexp.escape';

// Specifing the file allows vitest to detect changes in the source files in watch mode:
import worker, { FIXED, DEFAULTS } from "./worker.js";

// Basic conditions where:
// - message.forward mock doesn't throw any exceptions
// - nothing pathological
//  
describe('Email forwarding: basic conditions', () => {
    const context = {};
    const TEST = {
        ...DEFAULTS,
        REJECT_TREATMENT: 'default reject reason'
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
        rawSize: 999,
    };
    const forward = vi.spyOn(message, 'forward');
    const setReject = vi.spyOn(message, 'setReject');

    beforeEach(async () => {
        message.to = null;
    });

    afterEach(async () => {
        vi.clearAllMocks();
        vi.resetAllMocks();
    });

    const failHeaders = new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_FAIL });
    const passHeaders = new Headers({ [TEST.CUSTOM_HEADER]: TEST.CUSTOM_HEADER_PASS });

    // Reference test data
    const r = {
        user: 'user',
        dest: 'user@email.com',
        destSubaddressed: '+forwarded@email.com',
        destDomain: '@email.com',
        rejectDest: 'user+spam@email.com',
        rejectDestSubaddressed: '+spam@email.com',
        rejectDestDomain: '@reject.com',
        rejectReason: 'common reject reason',
        rejectReasonNeedingUserPrepend: ': reject reason needing user prepend',
        rejectReasonNeedingUserPrepend2: ': reject reason needing user prepend 2',
        user1: 'user1',
        dest1: 'user1@email.com',
        dest1a: 'user1a@email.com',
        dest1b: 'user1b@email.com',
        rejectDest1: 'user1+spam@email.com',
        rejectDest1a: 'user1+spam1a@email.com',
        rejectDest1b: 'user1+spam1b@email.com',
        rejectReason1: 'reject reason 1',
        user2: 'user2',
        dest2: 'user2@email.com',
        rejectDest2: 'user2+spam@email.com',
        rejectReason1: 'reject reason 2',
        user3: 'user3',
        dest3: 'user3@email.com',
        rejectDest3: 'user3+spam@email.com',
        rejectReason3: 'reject reason 3',
        user4: 'user4',
        dest4: 'user4@email.com',
        rejectDest4: 'user4+spam@email.com',
        rejectReason4: 'reject reason 4',
        user5: 'user5',
        dest5: 'user5@email.com',
        rejectDest5: 'user5+spam@email.com',
        rejectReason5: 'reject reason 5',
        user6: 'user6',
        dest6: 'user6@email.com',
        rejectDest6: 'user6+spam@email.com',
        rejectReason6: 'reject reason 6',
        user7: 'user7',
        dest7: 'user7@email.com',
        rejectDest7: 'user7+spam@email.com',
        rejectReason7: 'reject reason 7',
        user8: 'user8',
        dest8: 'user8@email.com',
        rejectDest8: 'user8+spam@email.com',
        rejectReason8: 'reject reason 8',
        destSpecial1: 'USER1@email.com',
        destSpecial2: 'USER2@email.com',
    };

    describe('Defaults', () => {
        const environment = { ...TEST };

        it.each([
            ['user1@domain.com', environment.REJECT_TREATMENT],
            ['user1+subA@domain.com', environment.REJECT_TREATMENT],
            ['user2@domain.com', environment.REJECT_TREATMENT],
            ['user2+subA@domain.com', environment.REJECT_TREATMENT],
            ['user2+subB@domain.com', environment.REJECT_TREATMENT],
        ])('%s should reject with "%s"', async (to, reason) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).not.toHaveBeenCalled();
            expect(setReject).toHaveBeenCalledWith(reason);
            expect(setReject).toHaveBeenCalledTimes(1);
        });
    });

    describe('Environment variables', () => {

        describe('Single user, any subaddress, single destination, reject', () => {
            const environment = {
                ...TEST,
                USERS: r.user1,
                DESTINATION: r.dest
            };

            it.each([
                ['user1@domain.com', r.dest],
                ['user1+subA@domain.com', r.dest],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user2@domain.com', environment.REJECT_TREATMENT],
                ['user2+subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });

        describe('Multiple users, any subaddress, subaddressed destination, subaddressed fail-forward', () => {
            const environment = {
                ...TEST,
                USERS: 'user1,user2',
                DESTINATION: r.destSubaddressed,
                REJECT_TREATMENT: r.rejectDestSubaddressed
            };

            it.each([
                ['user1@domain.com', `user1${r.destSubaddressed}`],
                ['user1+subA@domain.com', `user1${r.destSubaddressed}`],
                ['user2@domain.com', `user2${r.destSubaddressed}`],
                ['user2+subA@domain.com', `user2${r.destSubaddressed}`],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user3@domain.com', `user3${r.rejectDestSubaddressed}`],
                ['user3+subA@domain.com', `user3${r.rejectDestSubaddressed}`],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, failHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });

        describe('Multiple users, any subaddress, domain destination, domain fail-forward', () => {
            const environment = {
                ...TEST,
                USERS: 'user1,user2',
                DESTINATION: r.destDomain,
                REJECT_TREATMENT: r.rejectDestDomain
            };

            it.each([
                ['user1@domain.com', `user1${r.destDomain}`],
                ['user1+subA@domain.com', `user1${r.destDomain}`],
                ['user2@domain.com', `user2${r.destDomain}`],
                ['user2+subA@domain.com', `user2${r.destDomain}`],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user3@domain.com', `user3${r.rejectDestDomain}`],
                ['user3+subA@domain.com', `user3${r.rejectDestDomain}`],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, failHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });

        describe('Any user, specific subaddresses, single destination, custom reject', () => {
            const environment = {
                ...TEST,
                USERS: '*',
                SUBADDRESSES: 'subA,subB,subC+suffix',
                DESTINATION: r.dest,
                REJECT_TREATMENT: r.rejectReason
            };

            it.each([
                ['user1@domain.com', r.dest],
                ['user1+subA@domain.com', r.dest],
                ['user1+subB@domain.com', r.dest],
                ['user1+subC+suffix@domain.com', r.dest],
                ['userN@domain.com', r.dest],
                ['userN+subA@domain.com', r.dest],
                ['userN+subB@domain.com', r.dest],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['userN+subC@domain.com', environment.REJECT_TREATMENT],
                ['userN+subD@domain.com', environment.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });

        describe('..., custom subaddressing separator character, custom forward header', () => {
            const environment = {
                ...TEST,
                USERS: r.user1,
                DESTINATION: r.dest,
                FORMAT_LOCAL_PART_SEPARATOR: '--',
                REJECT_TREATMENT: r.rejectDest,
                CUSTOM_HEADER: 'X-CUSTOM'
            };

            it.each([
                ['user1@domain.com', r.dest],
                ['user1--subA@domain.com', r.dest],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [environment.CUSTOM_HEADER]: environment.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user1+subA@domain.com', environment.REJECT_TREATMENT],
                ['user2@domain.com', environment.REJECT_TREATMENT],
                ['user2--subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [environment.CUSTOM_HEADER]: environment.CUSTOM_HEADER_FAIL }));
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });

        describe('Message local part comparision is case insensitive; Destination is case sensitive', () => {
            const environment = {
                ...TEST,
                USERS: r.user1,
                SUBADDRESSES: 'subA',
                DESTINATION: r.destSpecial1
            };

            it.each([
                ['user1@domain.com', r.destSpecial1],
                ['USER1@domain.com', r.destSpecial1],
                ['user1+suba@domain.com', r.destSpecial1],
                ['USER1+SUBA@domain.com', r.destSpecial1],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });
    });

    describe('KV globals', () => {

        describe('Destination validation', () => {
            const MAP = new Map();
            MAP.set('@SUBADDRESSES', 'subA');
            MAP.set('@REJECT_TREATMENT', r.rejectReason);
            MAP.set(r.user1, `;`);
            MAP.set(r.user2, `missingdomain`);
            MAP.set(r.user3, `missingdomain@;missingdomain@`);
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', r.rejectReason],
                ['user1+subA@domain.com', r.rejectReason],
                ['user1+subB@domain.com', r.rejectReason],
                ['user2@domain.com', r.rejectReason],
                ['user2+subA@domain.com', r.rejectReason],
                ['user2+subB@domain.com', r.rejectReason],
                ['user3@domain.com', r.rejectReason],
                ['user3+subA@domain.com', r.rejectReason],
                ['user3+subB@domain.com', r.rejectReason],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });

        describe('Single user, any subaddress, single destination, reject', () => {
            const MAP = new Map();
            MAP.set('@USERS', r.user1);
            MAP.set('@DESTINATION', r.dest);
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', r.dest],
                ['user1+subA@domain.com', r.dest],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user2@domain.com', environment.REJECT_TREATMENT],
                ['user2+subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });

        describe('Multiple users, any subaddress, domain destination, domain fail-forward', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1,user2');
            MAP.set('@DESTINATION', r.destDomain);
            MAP.set('@REJECT_TREATMENT', r.rejectDestDomain);
            MAP.set(r.user3, '');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', `user1${r.destDomain}`],
                ['user1+subA@domain.com', `user1${r.destDomain}`],
                ['user2@domain.com', `user2${r.destDomain}`],
                ['user2+subA@domain.com', `user2${r.destDomain}`],
                ['user3+subA@domain.com', `user3${r.destDomain}`],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user4@domain.com', `user4${r.rejectDestDomain}`],
                ['user4+subA@domain.com', `user4${r.rejectDestDomain}`],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, failHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });

        describe('Multiple users, any subaddress, subaddressed destination, subaddressed fail-forward', () => {
            const MAP = new Map();
            MAP.set('@USERS', 'user1,user2');
            MAP.set('@DESTINATION', r.destSubaddressed);
            MAP.set('@REJECT_TREATMENT', r.rejectDestSubaddressed);
            MAP.set(r.user3, '');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', `user1${r.destSubaddressed}`],
                ['user1+subA@domain.com', `user1${r.destSubaddressed}`],
                ['user2@domain.com', `user2${r.destSubaddressed}`],
                ['user2+subA@domain.com', `user2${r.destSubaddressed}`],
                ['user3+subA@domain.com', `user3${r.destSubaddressed}`],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user4@domain.com', `user4${r.rejectDestSubaddressed}`],
                ['user4+subA@domain.com', `user4${r.rejectDestSubaddressed}`],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, failHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });

        describe('Any user, specific subaddresses, single destination, custom reject', () => {
            const MAP = new Map();
            MAP.set('@USERS', '*');
            MAP.set('@SUBADDRESSES', 'subA,subB,subC+suffix');
            MAP.set('@DESTINATION', r.dest);
            MAP.set('@REJECT_TREATMENT', r.rejectReason);
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', r.dest],
                ['user1+subA@domain.com', r.dest],
                ['user1+subB@domain.com', r.dest],
                ['user1+subC+suffix@domain.com', r.dest],
                ['userN@domain.com', r.dest],
                ['userN+subA@domain.com', r.dest],
                ['userN+subB@domain.com', r.dest],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['userN+subC@domain.com', r.rejectReason],
                ['userN+subD@domain.com', r.rejectReason],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('KV users', () => {

        describe('Multiple users, any subaddress, user destination, reject', () => {
            const MAP = new Map();
            MAP.set(r.user1, r.dest1);
            MAP.set(r.user2, `${r.dest2};${r.rejectDest2}`);
            MAP.set(r.user3, '');
            const environment = {
                ...TEST,
                DESTINATION: r.dest3,
                MAP
            };

            it.each([
                ['user1@domain.com', r.dest1],
                ['user1+subA@domain.com', r.dest1],
                ['user2@domain.com', r.dest2],
                ['user2+subA@domain.com', r.dest2],
                ['user3@domain.com', r.dest3],
                ['user3+subA@domain.com', r.dest3],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user4@domain.com', environment.REJECT_TREATMENT],
                ['user4+subA@domain.com', environment.REJECT_TREATMENT],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });

        describe('Multiple users, user subaddresses, user destination, mixed error handling', () => {
            const MAP = new Map();
            MAP.set(r.user1, 'user1@email.com');
            MAP.set('user1+', 'subA');
            MAP.set(r.user2, `${r.dest2};${r.rejectDest2}`);
            MAP.set('user2+', 'subA,subB');
            MAP.set(r.user4, `${r.dest4};${r.rejectReason4}`);
            MAP.set('user4+', '+');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', r.dest1],
                ['user1+subA@domain.com', r.dest1],
                ['user2@domain.com', r.dest2],
                ['user2+subA@domain.com', r.dest2],
                ['user2+subB@domain.com', r.dest2],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user2+subC@domain.com', r.rejectDest2],
            ])('%s should forward to "%s"', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, failHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user1+subB@domain.com', environment.REJECT_TREATMENT],
                ['user3@domain.com', environment.REJECT_TREATMENT],
                ['user3+subA@domain.com', environment.REJECT_TREATMENT],
                ['user4@domain.com', r.rejectReason4],
                ['user4+subA@domain.com', r.rejectReason4],
            ])('%s should reject with "%s"', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('Message local part comparision is case insensitive; Destination is case sensitive', () => {
        const MAP = new Map();
        MAP.set('@SUBADDRESSES', 'subA');
        MAP.set('@DESTINATION', r.destSpecial1);
        MAP.set(r.user1, '');
        MAP.set(r.user2, r.destSpecial2);
        const environment = { ...TEST, MAP };

        it.each([
            ['user1+suba@domain.com', r.destSpecial1],
            ['USER1+SUBA@domain.com', r.destSpecial1],
            ['user2+suba@domain.com', r.destSpecial2],
            ['USER2+SUBA@domain.com', r.destSpecial2],
        ])('%s should forward to %s', async (to, dest) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).toHaveBeenCalledWith(dest, passHeaders);
            expect(forward).toHaveBeenCalledTimes(1);
            expect(setReject).not.toHaveBeenCalled();
        });
    });

    describe('Mixed configurations', () => {

        describe('KV globals override environment variables', () => {
            const MAP = new Map();
            MAP.set('@USERS', r.user2);
            MAP.set('@SUBADDRESSES', 'subA,subB');
            MAP.set('@DESTINATION', r.dest2);
            const environment = {
                ...TEST,
                USERS: r.user1,
                DESTINATION: 'user1@email.com',
                FORMAT_LOCAL_PART_SEPARATOR: '--',
                REJECT_TREATMENT: r.rejectReason,
                CUSTOM_HEADER: 'X-CUSTOM',
                MAP
            };

            it.each([
                ['user1@domain.com', r.rejectReason],
                ['user1--subA@domain.com', r.rejectReason],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });

            it.each([
                ['user2@domain.com', r.dest2],
                ['user2--subA@domain.com', r.dest2],
                ['user2--subB@domain.com', r.dest2],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, new Headers({ [environment.CUSTOM_HEADER]: environment.CUSTOM_HEADER_PASS }));
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user2--subC@domain.com', r.rejectReason],
                ['user2+subA@domain.com', r.rejectReason],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });
        });

        describe('KV users override KV globals', () => {
            const MAP = new Map();
            MAP.set('@USERS', r.user1);
            MAP.set('@SUBADDRESSES', 'subA,subB');
            MAP.set('@DESTINATION', r.dest);
            MAP.set('@REJECT_TREATMENT', r.rejectReason);
            MAP.set(r.user2, r.dest2);
            MAP.set('user2+', 'subC');
            MAP.set(r.user3, `${r.dest3};${r.rejectDest3}`);
            MAP.set(r.user4, r.dest4);
            MAP.set('user4+', '*');
            MAP.set(r.user5, r.dest5);
            MAP.set('user5+', '+*');
            MAP.set(r.user6, r.dest6);
            MAP.set('user6+', '');
            MAP.set(r.user7, r.dest7);
            MAP.set('user7+', '+');
            MAP.set(r.user8, r.dest8);
            MAP.set('user8+', '+ subC,subD');
            const environment = { ...TEST, MAP };

            it.each([
                ['user1@domain.com', r.dest],
                ['user1+subA@domain.com', r.dest],
                ['user1+subB@domain.com', r.dest],
                ['user2@domain.com', r.dest2],
                ['user2+subC@domain.com', r.dest2],
                ['user3@domain.com', r.dest3],
                ['user3+subA@domain.com', r.dest3],
                ['user3+subB@domain.com', r.dest3],
                ['user4@domain.com', r.dest4],
                ['user4+subC@domain.com', r.dest4],
                ['user4+subD@domain.com', r.dest4],
                ['user5+subC@domain.com', r.dest5],
                ['user5+subD@domain.com', r.dest5],
                ['user6@domain.com', r.dest6],
                ['user8+subC@domain.com', r.dest8],
                ['user8+subD@domain.com', r.dest8],
            ])('%s should forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, passHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });

            it.each([
                ['user1+subC@domain.com', r.rejectReason],
                ['user2+subA@domain.com', r.rejectReason],
                ['user2+subB@domain.com', r.rejectReason],
                ['user5@domain.com', r.rejectReason],
                ['user6+subA@domain.com', r.rejectReason],
                ['user6+subB@domain.com', r.rejectReason],
                ['user7@domain.com', r.rejectReason],
                ['user7+subA@domain.com', r.rejectReason],
                ['user7+subB@domain.com', r.rejectReason],
                ['user8@domain.com', r.rejectReason],
                ['user8+subA@domain.com', r.rejectReason],
                ['user8+subB@domain.com', r.rejectReason],
            ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).not.toHaveBeenCalled();
                expect(setReject).toHaveBeenCalledWith(reason);
                expect(setReject).toHaveBeenCalledTimes(1);
            });

            it.each([
                ['user3+subC@domain.com', r.rejectDest3],
            ])('%s should reject forward to %s', async (to, dest) => {
                message.to = to;
                await worker.email(message, environment, context);
                expect(forward).toHaveBeenCalledWith(dest, failHeaders);
                expect(forward).toHaveBeenCalledTimes(1);
                expect(setReject).not.toHaveBeenCalled();
            });
        });
    });

    describe('KV user destination of empty string defaulting to global destination', () => {
        const MAP = new Map();
        MAP.set('@DESTINATION', r.dest);
        MAP.set('@REJECT_TREATMENT', r.rejectReason);
        MAP.set(r.user1, '');
        MAP.set('user1+', 'subA');
        MAP.set(r.user2, ' ');
        MAP.set('user2+', 'subA');
        MAP.set(r.user3, ' ; ');
        MAP.set('user3+', 'subA');
        MAP.set(r.user4, ` ; ${r.rejectReason4}  `);
        MAP.set('user4+', 'subA');
        const environment = { ...TEST, MAP };

        it.each([
            ['user1@domain.com', r.dest],
            ['user1+subA@domain.com', r.dest],
            ['user2@domain.com', r.dest],
            ['user2+subA@domain.com', r.dest],
            ['user3@domain.com', r.dest],
            ['user3+subA@domain.com', r.dest],
            ['user4@domain.com', r.dest],
            ['user4+subA@domain.com', r.dest],
        ])('%s should forward to %s', async (to, dest) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).toHaveBeenCalledWith(dest, passHeaders);
            expect(forward).toHaveBeenCalledTimes(1);
            expect(setReject).not.toHaveBeenCalled();
        });

        it.each([
            ['user1+subB@domain.com', r.rejectReason],
            ['user2+subB@domain.com', r.rejectReason],
            ['user3+subB@domain.com', r.rejectReason],
            ['user4+subB@domain.com', r.rejectReason4],
        ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).not.toHaveBeenCalled();
            expect(setReject).toHaveBeenCalledWith(reason);
            expect(setReject).toHaveBeenCalledTimes(1);
        });
    });

    describe('Prepending of local-part to reject reason', () => {
        const MAP = new Map();
        MAP.set('@USERS', r.user1);
        MAP.set('@SUBADDRESSES', 'subA');
        MAP.set('@REJECT_TREATMENT', ` ${r.rejectReasonNeedingUserPrepend} `);
        MAP.set(r.user1, `${r.dest1};  `);
        MAP.set(r.user2, `${r.dest2};  ${r.rejectReasonNeedingUserPrepend2}`);
        const environment = { ...TEST, MAP };

        it.each([
            ['user1+subB@domain.com', 'user1+subB' + r.rejectReasonNeedingUserPrepend],
        ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).not.toHaveBeenCalled();
            expect(setReject).toHaveBeenCalledWith(reason);
            expect(setReject).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['user2+subB@domain.com', 'user2+subB' + r.rejectReasonNeedingUserPrepend2],
        ])('%s should direct reject with reason \'%s\'', async (to, reason) => {
            message.to = to;
            await worker.email(message, environment, context);
            expect(forward).not.toHaveBeenCalled();
            expect(setReject).toHaveBeenCalledWith(reason);
            expect(setReject).toHaveBeenCalledTimes(1);
        });
    });
});