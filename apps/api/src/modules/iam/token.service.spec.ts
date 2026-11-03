import {
    ACCESS_TOKEN_ISSUER,
    AccessTokenVerifier,
    loadAccessTokenSecret,
} from '@app/rbac';
import { decodeJwt } from 'jose';
import { loadIamConfig } from './iam.config.js';
import { TokenService } from './token.service.js';

const env = { ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000' };
const claims = {
    publicId: '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10',
    role: 'BDA' as const,
    familyId: 'family-1',
    mustChangePassword: false,
};

describe('TokenService', () => {
    const service = new TokenService(loadIamConfig(env));

    describe('signAccessToken', () => {
        it('signs a token the RBAC library accepts and reads back unchanged', async () => {
            const verifier = new AccessTokenVerifier(
                loadAccessTokenSecret(env),
            );

            await expect(
                verifier.verify(await service.signAccessToken(claims)),
            ).resolves.toEqual(claims);
        });

        it('keeps the must-change-password flag', async () => {
            const verifier = new AccessTokenVerifier(
                loadAccessTokenSecret(env),
            );
            const token = await service.signAccessToken({
                ...claims,
                mustChangePassword: true,
            });

            await expect(verifier.verify(token)).resolves.toMatchObject({
                mustChangePassword: true,
            });
        });

        it('names the subject, the issuer and a 15 minute lifetime', async () => {
            const payload = decodeJwt(await service.signAccessToken(claims));

            expect(payload.sub).toBe(claims.publicId);
            expect(payload.iss).toBe(ACCESS_TOKEN_ISSUER);
            expect(payload.exp! - payload.iat!).toBe(15 * 60);
        });
    });

    it('creates unpredictable refresh tokens and a 64 character SHA-256 hash for storage', () => {
        const first = service.newRefreshToken();
        const second = service.newRefreshToken();

        expect(first.token).not.toBe(second.token);
        expect(first.token.length).toBeGreaterThanOrEqual(43);
        expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(service.hash(first.token)).toBe(first.hash);
        expect(first.hash).not.toBe(second.hash);
    });

    it('creates a different CSRF token each time', () => {
        expect(service.newCsrfToken()).not.toBe(service.newCsrfToken());
    });
});
