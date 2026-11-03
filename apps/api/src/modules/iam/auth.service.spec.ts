import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import argon2 from 'argon2';
import { jwtVerify } from 'jose';
import { AuthService } from './auth.service.js';
import { loadIamConfig } from './iam.config.js';
import type { IamRepository } from './iam.repository.js';
import type { StaffAccount } from './iam.types.js';
import { PasswordService } from './password.service.js';
import { ACCESS_TOKEN_ISSUER, TokenService } from './token.service.js';

const SECRET = 'unit-test-secret-unit-test-secret-000';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const META = { ip: '203.0.113.7', userAgent: 'vitest' };

describe('AuthService.login', () => {
    const config = loadIamConfig({ ACCESS_TOKEN_SECRET: SECRET });
    const repository = {
        findStaffByEmail: vi.fn(),
        recordFailedLogin: vi.fn(),
        recordSuccessfulLogin: vi.fn(),
    };
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
        service = new AuthService(
            repository as unknown as IamRepository,
            passwords,
            new TokenService(config),
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
});
