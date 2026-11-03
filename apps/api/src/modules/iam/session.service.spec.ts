import { createHash } from 'node:crypto';
import { type AdminService, AuditAction } from '@modules/admin';
import { ACCESS_TOKEN_ISSUER } from '@app/rbac';
import { jwtVerify } from 'jose';
import { loadIamConfig } from './iam.config.js';
import type { IamRepository } from './iam.repository.js';
import type { SessionLookup, StaffAccount } from './iam.types.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

const SECRET = 'unit-test-secret-unit-test-secret-000';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const META = { ip: '203.0.113.7', userAgent: 'vitest' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('SessionService', () => {
    const config = loadIamConfig({ ACCESS_TOKEN_SECRET: SECRET });
    const repository = {
        findSessionByTokenHash: vi.fn(),
        findStaffByPublicId: vi.fn(),
        rotateSession: vi.fn(),
        revokeFamily: vi.fn(),
        familyHasActiveSession: vi.fn(),
    };
    const admin = { audit: vi.fn() };
    let service: SessionService;

    const account: StaffAccount = {
        id: 7n,
        publicId: '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10',
        name: 'Asha Rao',
        email: 'asha@example.com',
        passwordHash: 'hash',
        role: 'BDA',
        isActive: true,
        mustChangePassword: false,
        lockedUntil: null,
    };

    /** The session row a refresh token resolves to. `revokedSecondsAgo` marks it as already used. */
    function lookup(
        overrides: {
            revokedSecondsAgo?: number;
            expiresAt?: Date;
            account?: Partial<StaffAccount>;
        } = {},
    ): SessionLookup {
        return {
            session: {
                id: 100n,
                userId: 7n,
                familyId: 'family-1',
                expiresAt:
                    overrides.expiresAt ?? new Date('2026-11-08T10:00:00.000Z'),
                revokedAt:
                    overrides.revokedSecondsAgo === undefined
                        ? null
                        : new Date(
                              NOW.getTime() -
                                  overrides.revokedSecondsAgo * 1000,
                          ),
            },
            account: { ...account, ...overrides.account },
        };
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        vi.resetAllMocks();
        repository.findSessionByTokenHash.mockResolvedValue(lookup());
        repository.rotateSession.mockResolvedValue(true);
        repository.revokeFamily.mockResolvedValue(1);
        repository.familyHasActiveSession.mockResolvedValue(true);
        repository.findStaffByPublicId.mockResolvedValue(account);
        service = new SessionService(
            repository as unknown as IamRepository,
            new TokenService(config),
            admin as unknown as AdminService,
            config,
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const status = (promise: Promise<unknown>) =>
        promise.then(
            () => 0,
            (error: { getStatus(): number }) => error.getStatus(),
        );

    describe('refresh', () => {
        it('looks the token up by its hash and answers 401 when there is none', async () => {
            expect(await status(service.refresh(undefined, META))).toBe(401);
            expect(repository.findSessionByTokenHash).not.toHaveBeenCalled();

            repository.findSessionByTokenHash.mockResolvedValue(null);
            expect(await status(service.refresh('nope', META))).toBe(401);
            expect(repository.findSessionByTokenHash).toHaveBeenCalledWith(
                sha('nope'),
            );
        });

        it('replaces the token inside the same sign-in and returns all three cookies', async () => {
            const result = await service.refresh('old-token', META);

            expect(repository.rotateSession).toHaveBeenCalledTimes(1);
            const [oldId, userId, next, now] =
                repository.rotateSession.mock.calls[0];
            expect(oldId).toBe(100n);
            expect(userId).toBe(7n);
            expect(next.familyId).toBe('family-1');
            expect(next.tokenHash).toBe(sha(result.tokens.refresh!));
            expect(next.expiresAt).toEqual(
                new Date('2026-11-10T10:00:00.000Z'),
            );
            expect(next.ip).toBe('203.0.113.7');
            expect(now).toEqual(NOW);
            expect(result.tokens.csrf).toEqual(expect.any(String));
            expect(result.user).toMatchObject({
                id: account.publicId,
                role: 'BDA',
                mustChangePassword: false,
            });
        });

        it('takes role and password state from the database, not from anything old', async () => {
            repository.findSessionByTokenHash.mockResolvedValue(
                lookup({
                    account: { role: 'CLOSER', mustChangePassword: true },
                }),
            );

            const result = await service.refresh('old-token', META);
            const { payload } = await jwtVerify(
                result.tokens.access,
                new TextEncoder().encode(SECRET),
                { issuer: ACCESS_TOKEN_ISSUER, currentDate: NOW },
            );

            expect(payload.role).toBe('CLOSER');
            expect(payload.mcp).toBe(true);
            expect(payload.fam).toBe('family-1');
        });

        it('answers 401 for an expired token without rotating', async () => {
            repository.findSessionByTokenHash.mockResolvedValue(
                lookup({ expiresAt: new Date('2026-11-03T09:59:59.000Z') }),
            );

            expect(await status(service.refresh('old-token', META))).toBe(401);
            expect(repository.rotateSession).not.toHaveBeenCalled();
        });

        it('ends the sign-in of a deactivated account', async () => {
            repository.findSessionByTokenHash.mockResolvedValue(
                lookup({ account: { isActive: false } }),
            );

            expect(await status(service.refresh('old-token', META))).toBe(401);
            expect(repository.revokeFamily).toHaveBeenCalledWith(
                'family-1',
                NOW,
            );
            expect(repository.rotateSession).not.toHaveBeenCalled();
        });

        describe('a token that was already replaced', () => {
            it('ends the whole sign-in and records it when an old token comes back late', async () => {
                repository.findSessionByTokenHash.mockResolvedValue(
                    lookup({ revokedSecondsAgo: 11 }),
                );

                expect(await status(service.refresh('old-token', META))).toBe(
                    401,
                );
                expect(repository.revokeFamily).toHaveBeenCalledWith(
                    'family-1',
                    NOW,
                );
                expect(admin.audit).toHaveBeenCalledWith({
                    action: AuditAction.RefreshReuseDetected,
                    actorId: 7n,
                    entityType: 'session',
                    entityId: 'family-1',
                    ip: '203.0.113.7',
                });
                expect(repository.rotateSession).not.toHaveBeenCalled();
            });

            it('treats a second tab a moment later as the same user: new access token only', async () => {
                repository.findSessionByTokenHash.mockResolvedValue(
                    lookup({ revokedSecondsAgo: 3 }),
                );

                const result = await service.refresh('old-token', META);

                expect(result.tokens.refresh).toBeUndefined();
                expect(result.tokens.csrf).toBeUndefined();
                expect(result.tokens.access).toEqual(expect.any(String));
                expect(repository.revokeFamily).not.toHaveBeenCalled();
                expect(admin.audit).not.toHaveBeenCalled();
            });

            it('does the same when another request wins the race to replace it', async () => {
                repository.rotateSession.mockResolvedValue(false);

                const result = await service.refresh('old-token', META);

                expect(result.tokens.refresh).toBeUndefined();
                expect(result.tokens.access).toEqual(expect.any(String));
                expect(repository.revokeFamily).not.toHaveBeenCalled();
            });

            it('answers 401 quietly after a logout, with nothing left to protect', async () => {
                repository.findSessionByTokenHash.mockResolvedValue(
                    lookup({ revokedSecondsAgo: 2 }),
                );
                repository.familyHasActiveSession.mockResolvedValue(false);

                expect(await status(service.refresh('old-token', META))).toBe(
                    401,
                );
                expect(repository.revokeFamily).not.toHaveBeenCalled();
                expect(admin.audit).not.toHaveBeenCalled();
            });
        });
    });

    describe('logout', () => {
        it('ends the whole sign-in the token belongs to and records it', async () => {
            await service.logout('old-token', META);

            expect(repository.findSessionByTokenHash).toHaveBeenCalledWith(
                sha('old-token'),
            );
            expect(repository.revokeFamily).toHaveBeenCalledWith(
                'family-1',
                NOW,
            );
            expect(admin.audit).toHaveBeenCalledWith({
                action: AuditAction.Logout,
                actorId: 7n,
                entityType: 'staff',
                entityId: account.publicId,
                ip: '203.0.113.7',
            });
        });

        it('quietly does nothing for a missing or unknown token', async () => {
            await service.logout(undefined, META);
            repository.findSessionByTokenHash.mockResolvedValue(null);
            await service.logout('unknown', META);

            expect(repository.revokeFamily).not.toHaveBeenCalled();
            expect(admin.audit).not.toHaveBeenCalled();
        });

        it('does not record a second logout of a sign-in that is already over', async () => {
            repository.revokeFamily.mockResolvedValue(0);

            await service.logout('old-token', META);

            expect(admin.audit).not.toHaveBeenCalled();
        });
    });

    describe('me', () => {
        const auth = {
            publicId: account.publicId,
            role: 'BDA' as const,
            familyId: 'family-1',
            mustChangePassword: false,
        };

        it('returns the account from the database', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...account,
                role: 'OPS',
            });

            await expect(service.me(auth)).resolves.toEqual({
                id: account.publicId,
                name: 'Asha Rao',
                email: 'asha@example.com',
                role: 'OPS',
                mustChangePassword: false,
            });
            expect(repository.familyHasActiveSession).toHaveBeenCalledWith(
                'family-1',
                NOW,
            );
        });

        it('answers 401 for a missing or deactivated account', async () => {
            repository.findStaffByPublicId.mockResolvedValue(null);
            expect(await status(service.me(auth))).toBe(401);

            repository.findStaffByPublicId.mockResolvedValue({
                ...account,
                isActive: false,
            });
            expect(await status(service.me(auth))).toBe(401);
        });

        it('answers 401 once the sign-in has been logged out, though the token has not expired', async () => {
            repository.familyHasActiveSession.mockResolvedValue(false);

            expect(await status(service.me(auth))).toBe(401);
        });
    });
});
