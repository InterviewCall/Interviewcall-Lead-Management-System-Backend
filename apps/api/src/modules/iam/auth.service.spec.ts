import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { type AdminService, AuditAction } from '@modules/admin';
import argon2 from 'argon2';
import { ACCESS_TOKEN_ISSUER } from '@app/rbac';
import { jwtVerify } from 'jose';
import { AuthService } from './auth.service.js';
import { loadIamConfig } from './iam.config.js';
import type { IamRepository } from './iam.repository.js';
import type { StaffAccount } from './iam.types.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/** JSON.stringify that copes with the bigint ids in audit entries. */
const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
    );

const SECRET = 'unit-test-secret-unit-test-secret-000';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const META = { ip: '203.0.113.7', userAgent: 'vitest' };

describe('AuthService.login', () => {
    const config = loadIamConfig({ ACCESS_TOKEN_SECRET: SECRET });
    const repository = {
        findStaffByEmail: vi.fn(),
        findStaffByPublicId: vi.fn(),
        recordFailedLogin: vi.fn(),
        recordSuccessfulLogin: vi.fn(),
        changePassword: vi.fn(),
    };
    const admin = { audit: vi.fn() };
    const passwords = new PasswordService();
    let service: AuthService;
    let account: StaffAccount;

    beforeAll(async () => {
        // Cheap parameters: the verify step reads them from the hash itself.
        const passwordHash = await argon2.hash('correct-password', {
            type: argon2.argon2id,
            memoryCost: 1024,
            timeCost: 2,
            parallelism: 1,
        });
        account = {
            id: 7n,
            publicId: '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10',
            name: 'Asha Rao',
            email: 'asha@example.com',
            passwordHash,
            role: 'BDA',
            isActive: true,
            mustChangePassword: true,
            lockedUntil: null,
        };
    });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        vi.resetAllMocks();
        repository.findStaffByEmail.mockResolvedValue(account);
        repository.recordFailedLogin.mockResolvedValue(false);
        repository.recordSuccessfulLogin.mockResolvedValue(undefined);
        repository.findStaffByPublicId.mockResolvedValue(account);
        repository.changePassword.mockResolvedValue(undefined);
        service = new AuthService(
            repository as unknown as IamRepository,
            passwords,
            new TokenService(config),
            admin as unknown as AdminService,
            config,
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function failure(promise: Promise<unknown>): Promise<HttpException> {
        const error = await promise.then(
            () => undefined,
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(HttpException);
        return error as HttpException;
    }

    it('signs in, returns the user and stores only the hash of the refresh token', async () => {
        const result = await service.login(
            { email: account.email, password: 'correct-password' },
            META,
        );

        expect(result.user).toEqual({
            id: account.publicId,
            name: 'Asha Rao',
            email: 'asha@example.com',
            role: 'BDA',
            mustChangePassword: true,
        });
        expect(JSON.stringify(result)).not.toContain(account.passwordHash);

        expect(repository.recordSuccessfulLogin).toHaveBeenCalledTimes(1);
        const [userId, session, stampedAt] =
            repository.recordSuccessfulLogin.mock.calls[0];
        expect(userId).toBe(7n);
        expect(stampedAt).toEqual(NOW);
        expect(session.tokenHash).toBe(
            createHash('sha256').update(result.tokens.refresh).digest('hex'),
        );
        expect(session.tokenHash).not.toBe(result.tokens.refresh);
        expect(session.expiresAt).toEqual(new Date('2026-11-10T10:00:00.000Z'));
        expect(session.userAgent).toBe('vitest');
        expect(session.ip).toBe('203.0.113.7');
        expect(repository.recordFailedLogin).not.toHaveBeenCalled();
    });

    it('issues a 15 minute access token tied to the new session family', async () => {
        const result = await service.login(
            { email: account.email, password: 'correct-password' },
            META,
        );
        const session = repository.recordSuccessfulLogin.mock.calls[0][1];

        const { payload } = await jwtVerify(
            result.tokens.access,
            new TextEncoder().encode(SECRET),
            {
                issuer: ACCESS_TOKEN_ISSUER,
                currentDate: NOW,
            },
        );
        expect(payload.sub).toBe(account.publicId);
        expect(payload.role).toBe('BDA');
        expect(payload.fam).toBe(session.familyId);
        expect(payload.mcp).toBe(true);
        expect(payload.exp! - payload.iat!).toBe(15 * 60);
    });

    it('rejects an unknown email with the same answer as a wrong password', async () => {
        repository.findStaffByEmail.mockResolvedValue(null);
        const unknown = await failure(
            service.login({ email: 'nobody@example.com', password: 'x' }, META),
        );

        repository.findStaffByEmail.mockResolvedValue(account);
        const wrong = await failure(
            service.login({ email: account.email, password: 'wrong' }, META),
        );

        expect(unknown.getStatus()).toBe(401);
        expect(unknown.getResponse()).toEqual({
            code: 'INVALID_CREDENTIALS',
            message: 'Email or password is incorrect',
        });
        expect(wrong.getResponse()).toEqual(unknown.getResponse());
        expect(repository.recordSuccessfulLogin).not.toHaveBeenCalled();
    });

    it('rejects a deactivated account even with the right password', async () => {
        repository.findStaffByEmail.mockResolvedValue({
            ...account,
            isActive: false,
        });
        const error = await failure(
            service.login(
                { email: account.email, password: 'correct-password' },
                META,
            ),
        );

        expect(error.getStatus()).toBe(401);
        expect(repository.recordSuccessfulLogin).not.toHaveBeenCalled();
        expect(repository.recordFailedLogin).not.toHaveBeenCalled();
    });

    it('counts a wrong password and asks for a 15 minute lock after 10 failures', async () => {
        await failure(
            service.login({ email: account.email, password: 'wrong' }, META),
        );

        expect(repository.recordFailedLogin).toHaveBeenCalledWith(7n, {
            maxAttempts: 10,
            lockUntil: new Date('2026-11-03T10:15:00.000Z'),
        });
        expect(repository.recordSuccessfulLogin).not.toHaveBeenCalled();
    });

    it('answers 423 while locked and does not even check the password', async () => {
        repository.findStaffByEmail.mockResolvedValue({
            ...account,
            lockedUntil: new Date('2026-11-03T10:12:00.000Z'),
        });
        const verify = vi.spyOn(passwords, 'verify');

        const error = await failure(
            service.login(
                { email: account.email, password: 'correct-password' },
                META,
            ),
        );

        expect(error.getStatus()).toBe(423);
        expect(error.getResponse()).toEqual({
            code: 'ACCOUNT_LOCKED',
            message: 'Too many failed attempts. Try again in 12 minutes.',
        });
        expect(verify).not.toHaveBeenCalled();
        expect(repository.recordFailedLogin).not.toHaveBeenCalled();
        expect(repository.recordSuccessfulLogin).not.toHaveBeenCalled();
        verify.mockRestore();
    });

    it('lets the user in once the lock has expired', async () => {
        repository.findStaffByEmail.mockResolvedValue({
            ...account,
            lockedUntil: new Date('2026-11-03T09:59:59.000Z'),
        });

        await expect(
            service.login(
                { email: account.email, password: 'correct-password' },
                META,
            ),
        ).resolves.toBeDefined();
        expect(repository.recordSuccessfulLogin).toHaveBeenCalledTimes(1);
    });

    it('shortens an over-long user agent to fit the column', async () => {
        await service.login(
            { email: account.email, password: 'correct-password' },
            { ip: undefined, userAgent: 'a'.repeat(400) },
        );
        const session = repository.recordSuccessfulLogin.mock.calls[0][1];

        expect(session.userAgent).toHaveLength(255);
        expect(session.ip).toBeNull();
    });
    describe('audit', () => {
        it('records a sign-in with the account and address, nothing else', async () => {
            await service.login(
                { email: account.email, password: 'correct-password' },
                META,
            );

            expect(admin.audit).toHaveBeenCalledTimes(1);
            expect(admin.audit).toHaveBeenCalledWith({
                action: AuditAction.LoginSucceeded,
                actorId: 7n,
                entityType: 'staff',
                entityId: account.publicId,
                ip: '203.0.113.7',
            });
        });

        it('records a wrong password without the password or the email', async () => {
            await failure(
                service.login(
                    { email: account.email, password: 'hunter2-wrong' },
                    META,
                ),
            );

            expect(admin.audit).toHaveBeenCalledTimes(1);
            const entry = admin.audit.mock.calls[0][0];
            expect(entry).toMatchObject({
                action: AuditAction.LoginFailed,
                actorId: 7n,
                entityId: account.publicId,
                detail: { reason: 'wrong_password' },
            });
            expect(json(entry)).not.toContain('hunter2');
            expect(json(entry)).not.toContain(account.email);
        });

        it('also records the lock when the failure triggers it', async () => {
            repository.recordFailedLogin.mockResolvedValue(true);

            await failure(
                service.login(
                    { email: account.email, password: 'wrong' },
                    META,
                ),
            );

            expect(
                admin.audit.mock.calls.map(([entry]) => entry.action),
            ).toEqual([AuditAction.LoginFailed, AuditAction.AccountLocked]);
        });

        it('records an unknown email without storing it', async () => {
            repository.findStaffByEmail.mockResolvedValue(null);

            await failure(
                service.login(
                    { email: 'nobody@example.com', password: 'x' },
                    META,
                ),
            );

            const entry = admin.audit.mock.calls[0][0];
            expect(entry).toMatchObject({
                action: AuditAction.LoginFailed,
                actorId: null,
                entityId: null,
                detail: { reason: 'unknown_account' },
            });
            expect(json(entry)).not.toContain('nobody@example.com');
        });

        it('records a password change, and a failed attempt to change it', async () => {
            const auth = {
                publicId: account.publicId,
                role: 'BDA' as const,
                familyId: 'f',
                mustChangePassword: true,
            };
            await service.changePassword(
                auth,
                {
                    currentPassword: 'correct-password',
                    newPassword: 'a-brand-new-password',
                },
                META,
            );
            await failure(
                service.changePassword(
                    auth,
                    {
                        currentPassword: 'wrong',
                        newPassword: 'another-new-one-1',
                    },
                    META,
                ),
            );

            expect(
                admin.audit.mock.calls.map(([entry]) => entry.action),
            ).toEqual([
                AuditAction.PasswordChanged,
                AuditAction.PasswordChangeFailed,
            ]);
        });
    });

    describe('changePassword', () => {
        const auth = {
            publicId: '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10',
            role: 'BDA' as const,
            familyId: 'old-family',
            mustChangePassword: true,
        };
        const input = {
            currentPassword: 'correct-password',
            newPassword: 'a-brand-new-password',
        };

        it('stores a hash of the new password and ends every earlier session', async () => {
            await service.changePassword(auth, input, META);

            expect(repository.changePassword).toHaveBeenCalledTimes(1);
            const [userId, hash, session, stampedAt] =
                repository.changePassword.mock.calls[0];
            expect(userId).toBe(7n);
            expect(hash).not.toContain('a-brand-new-password');
            await expect(
                argon2.verify(hash, 'a-brand-new-password'),
            ).resolves.toBe(true);
            expect(session.expiresAt).toEqual(
                new Date('2026-11-10T10:00:00.000Z'),
            );
            expect(stampedAt).toEqual(NOW);
            expect(repository.recordFailedLogin).not.toHaveBeenCalled();
        });

        it('returns fresh tokens for a user who no longer has to change the password', async () => {
            const result = await service.changePassword(auth, input, META);
            const session = repository.changePassword.mock.calls[0][2];

            expect(result.user.mustChangePassword).toBe(false);
            expect(session.tokenHash).toBe(
                createHash('sha256')
                    .update(result.tokens.refresh)
                    .digest('hex'),
            );
            const { payload } = await jwtVerify(
                result.tokens.access,
                new TextEncoder().encode(SECRET),
                {
                    issuer: ACCESS_TOKEN_ISSUER,
                    currentDate: NOW,
                },
            );
            expect(payload.mcp).toBe(false);
            expect(payload.fam).toBe(session.familyId);
            expect(payload.fam).not.toBe('old-family');
        });

        it('answers 400 on the currentPassword field when it is wrong, and counts the failure', async () => {
            const error = await failure(
                service.changePassword(
                    auth,
                    { ...input, currentPassword: 'wrong' },
                    META,
                ),
            );

            expect(error.getStatus()).toBe(400);
            expect(error.getResponse()).toEqual({
                code: 'VALIDATION_FAILED',
                message: 'Some fields are invalid',
                fields: { currentPassword: 'Current password is incorrect' },
            });
            expect(repository.recordFailedLogin).toHaveBeenCalledTimes(1);
            expect(repository.changePassword).not.toHaveBeenCalled();
        });

        it('answers 423 while the account is locked, without checking the password', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...account,
                lockedUntil: new Date('2026-11-03T10:05:00.000Z'),
            });
            const verify = vi.spyOn(passwords, 'verify');

            const error = await failure(
                service.changePassword(auth, input, META),
            );

            expect(error.getStatus()).toBe(423);
            expect(verify).not.toHaveBeenCalled();
            expect(repository.changePassword).not.toHaveBeenCalled();
            verify.mockRestore();
        });

        it('answers 401 when the account is gone or deactivated', async () => {
            repository.findStaffByPublicId.mockResolvedValue({
                ...account,
                isActive: false,
            });
            expect(
                (
                    await failure(service.changePassword(auth, input, META))
                ).getStatus(),
            ).toBe(401);

            repository.findStaffByPublicId.mockResolvedValue(null);
            expect(
                (
                    await failure(service.changePassword(auth, input, META))
                ).getStatus(),
            ).toBe(401);
            expect(repository.changePassword).not.toHaveBeenCalled();
        });
    });
});
