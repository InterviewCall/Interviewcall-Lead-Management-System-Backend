import type { ModelService } from '@app/model';
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
});
