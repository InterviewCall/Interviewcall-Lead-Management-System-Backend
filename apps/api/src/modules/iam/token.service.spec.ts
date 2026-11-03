import { loadIamConfig } from './iam.config.js';
import { TokenService } from './token.service.js';

describe('TokenService', () => {
    const service = new TokenService(
        loadIamConfig({
            ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000',
        }),
    );

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
