import type { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import { IamRepository } from './iam.repository.js';

describe('IamRepository', () => {
    const rule = {
        maxAttempts: 10,
        lockUntil: new Date('2026-11-03T10:15:00.000Z'),
    };

    function build(failedLoginsAfterIncrement: number) {
        const update = vi
            .fn()
            .mockResolvedValueOnce({ failedLogins: failedLoginsAfterIncrement })
            .mockResolvedValue({});
        const tx = { staffUser: { update } };
        const db = {
            $transaction: vi.fn((work: (client: typeof tx) => unknown) =>
                work(tx),
            ),
        };
        return {
            repository: new IamRepository(db as unknown as ModelService),
            update,
        };
    }

    it('only counts the failure while under the limit', async () => {
        const { repository, update } = build(9);

        await expect(repository.recordFailedLogin(7n, rule)).resolves.toBe(
            false,
        );

        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { failedLogins: { increment: 1 } },
            }),
        );
    });

    it('locks the account and restarts the count when the limit is reached', async () => {
        const { repository, update } = build(10);

        await expect(repository.recordFailedLogin(7n, rule)).resolves.toBe(
            true,
        );

        expect(update).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenLastCalledWith({
            where: { id: 7n },
            data: { failedLogins: 0, lockedUntil: rule.lockUntil },
        });
    });

    it('clears failures and the lock and creates the session in one update', async () => {
        const update = vi.fn().mockResolvedValue({});
        const repository = new IamRepository({
            staffUser: { update },
        } as unknown as ModelService);
        const now = new Date('2026-11-03T10:00:00.000Z');
        const session = {
            tokenHash: 'h'.repeat(64),
            familyId: 'f',
            userAgent: null,
            ip: null,
            expiresAt: new Date('2026-11-10T10:00:00.000Z'),
        };

        await repository.recordSuccessfulLogin(7n, session, now);

        expect(update).toHaveBeenCalledWith({
            where: { id: 7n },
            data: {
                failedLogins: 0,
                lockedUntil: null,
                lastLoginAt: now,
                sessions: { create: session },
            },
        });
    });

    describe('createStaff', () => {
        const staff = {
            name: 'Ravi',
            email: 'ravi@example.com',
            role: 'BDA' as const,
            passwordHash: 'h',
        };

        it('creates a pending, active account', async () => {
            const create = vi.fn().mockResolvedValue({ id: 1n });
            const repository = new IamRepository({
                staffUser: { create },
            } as unknown as ModelService);

            await repository.createStaff(staff);

            expect(create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        ...staff,
                        isActive: true,
                        mustChangePassword: true,
                    },
                }),
            );
        });

        it('returns null when the email is already taken', async () => {
            const duplicate = new Prisma.PrismaClientKnownRequestError(
                'Unique constraint failed',
                {
                    code: 'P2002',
                    clientVersion: 'test',
                },
            );
            const create = vi.fn().mockRejectedValue(duplicate);
            const repository = new IamRepository({
                staffUser: { create },
            } as unknown as ModelService);

            await expect(repository.createStaff(staff)).resolves.toBeNull();
        });

        it('lets any other database error through', async () => {
            const create = vi
                .fn()
                .mockRejectedValue(new Error('connection lost'));
            const repository = new IamRepository({
                staffUser: { create },
            } as unknown as ModelService);

            await expect(repository.createStaff(staff)).rejects.toThrow(
                'connection lost',
            );
        });
    });

    describe('password writes', () => {
        const now = new Date('2026-11-03T10:00:00.000Z');
        const session = {
            tokenHash: 'h'.repeat(64),
            familyId: 'f',
            userAgent: null,
            ip: null,
            expiresAt: new Date('2026-11-10T10:00:00.000Z'),
        };

        function build() {
            const updateMany = vi.fn().mockReturnValue('revoke-sessions');
            const update = vi.fn().mockReturnValue('update-user');
            const transaction = vi.fn().mockResolvedValue([]);
            const db = {
                authSession: { updateMany },
                staffUser: { update },
                $transaction: transaction,
            };
            return {
                repository: new IamRepository(db as unknown as ModelService),
                updateMany,
                update,
                transaction,
            };
        }

        it('setTemporaryPassword ends all sessions, then makes the account pending again', async () => {
            const { repository, updateMany, update, transaction } = build();

            await repository.setTemporaryPassword(7n, 'new-hash', now);

            expect(updateMany).toHaveBeenCalledWith({
                where: { userId: 7n, revokedAt: null },
                data: { revokedAt: now },
            });
            expect(update).toHaveBeenCalledWith({
                where: { id: 7n },
                data: {
                    passwordHash: 'new-hash',
                    mustChangePassword: true,
                    failedLogins: 0,
                    lockedUntil: null,
                },
            });
            // One transaction, sessions first.
            expect(transaction).toHaveBeenCalledWith([
                'revoke-sessions',
                'update-user',
            ]);
        });

        it('changePassword ends the old sessions before the new one is created', async () => {
            const { repository, updateMany, update, transaction } = build();

            await repository.changePassword(7n, 'new-hash', session, now);

            expect(updateMany).toHaveBeenCalledWith({
                where: { userId: 7n, revokedAt: null },
                data: { revokedAt: now },
            });
            expect(update).toHaveBeenCalledWith({
                where: { id: 7n },
                data: {
                    passwordHash: 'new-hash',
                    mustChangePassword: false,
                    failedLogins: 0,
                    lockedUntil: null,
                    sessions: { create: session },
                },
            });
            expect(transaction).toHaveBeenCalledWith([
                'revoke-sessions',
                'update-user',
            ]);
        });
    });

    describe('rotateSession', () => {
        const next = {
            tokenHash: 'h'.repeat(64),
            familyId: 'family-1',
            userAgent: null,
            ip: null,
            expiresAt: new Date('2026-11-10T10:00:00.000Z'),
        };
        const now = new Date('2026-11-03T10:00:00.000Z');

        function rotation(updatedCount: number) {
            const updateMany = vi
                .fn()
                .mockResolvedValue({ count: updatedCount });
            const create = vi.fn().mockResolvedValue({});
            const tx = { authSession: { updateMany, create } };
            const db = {
                $transaction: vi.fn((work: (client: typeof tx) => unknown) =>
                    work(tx),
                ),
            };
            return {
                repository: new IamRepository(db as unknown as ModelService),
                updateMany,
                create,
            };
        }

        it('revokes only a token that is still live, then stores the next one', async () => {
            const { repository, updateMany, create } = rotation(1);

            await expect(
                repository.rotateSession(100n, 7n, next, now),
            ).resolves.toBe(true);

            expect(updateMany).toHaveBeenCalledWith({
                where: { id: 100n, revokedAt: null },
                data: { revokedAt: now },
            });
            expect(create).toHaveBeenCalledWith({
                data: { ...next, userId: 7n },
            });
        });

        it('stores nothing when another request already revoked the token', async () => {
            const { repository, create } = rotation(0);

            await expect(
                repository.rotateSession(100n, 7n, next, now),
            ).resolves.toBe(false);
            expect(create).not.toHaveBeenCalled();
        });
    });

    describe('listStaff', () => {
        function listing() {
            const findMany = vi.fn().mockReturnValue('FIND');
            const count = vi.fn().mockReturnValue('COUNT');
            const db = {
                staffUser: { findMany, count },
                $transaction: vi.fn().mockResolvedValue([[], 0]),
            };
            return {
                repository: new IamRepository(db as unknown as ModelService),
                findMany,
                count,
            };
        }

        it.each([
            ['DEACTIVATED', { isActive: false }],
            ['PENDING', { isActive: true, mustChangePassword: true }],
            ['ACTIVE', { isActive: true, mustChangePassword: false }],
        ] as const)(
            'turns status %s into the stored flags',
            async (status, flags) => {
                const { repository, findMany, count } = listing();

                await repository.listStaff({ status, page: 1, pageSize: 25 });

                expect(findMany.mock.calls[0][0].where).toEqual(flags);
                expect(count).toHaveBeenCalledWith({ where: flags });
            },
        );

        it('pages newest first and searches name and email', async () => {
            const { repository, findMany } = listing();

            await repository.listStaff({
                search: 'rav',
                role: 'CLOSER',
                page: 3,
                pageSize: 20,
            });

            expect(findMany.mock.calls[0][0]).toMatchObject({
                where: {
                    role: 'CLOSER',
                    OR: [
                        { name: { contains: 'rav' } },
                        { email: { contains: 'rav' } },
                    ],
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: 40,
                take: 20,
            });
        });
    });
});
