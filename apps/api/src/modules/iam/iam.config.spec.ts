import { loadIamConfig } from './iam.config.js';

const SECRET = 'unit-test-secret-unit-test-secret-000';

describe('loadIamConfig', () => {
    it('applies the documented defaults', () => {
        const config = loadIamConfig({ ACCESS_TOKEN_SECRET: SECRET });

        expect(config.accessTtlSeconds).toBe(15 * 60);
        expect(config.refreshTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
        expect(config.maxFailedLogins).toBe(10);
        expect(config.lockMs).toBe(15 * 60 * 1000);
        expect(config.secureCookies).toBe(false);
        expect(config.cookieDomain).toBeUndefined();
    });

    it('reads the lifetimes from the environment', () => {
        const config = loadIamConfig({
            ACCESS_TOKEN_SECRET: SECRET,
            ACCESS_TOKEN_TTL_MINUTES: '5',
            REFRESH_TOKEN_TTL_DAYS: '2',
        });

        expect(config.accessTtlSeconds).toBe(300);
        expect(config.refreshTtlMs).toBe(2 * 24 * 60 * 60 * 1000);
    });

    it('refuses to start without a strong secret, without printing it', () => {
        expect(() => loadIamConfig({})).toThrow(/ACCESS_TOKEN_SECRET/);
        expect(() =>
            loadIamConfig({ ACCESS_TOKEN_SECRET: 'short-secret' }),
        ).toThrow(/at least 32 characters/);
        expect(() =>
            loadIamConfig({ ACCESS_TOKEN_SECRET: 'short-secret' }),
        ).not.toThrow(/short-secret/);
    });

    it('rejects the .env.example placeholder in production', () => {
        const env = {
            ACCESS_TOKEN_SECRET: 'change-me-to-a-long-random-string',
            NODE_ENV: 'production',
        };

        expect(() => loadIamConfig(env)).toThrow(/placeholder/);
        expect(() =>
            loadIamConfig({ ...env, NODE_ENV: 'development' }),
        ).not.toThrow();
    });

    it('marks cookies Secure in production and uses the shared domain', () => {
        const config = loadIamConfig({
            ACCESS_TOKEN_SECRET: SECRET,
            NODE_ENV: 'production',
            COOKIE_DOMAIN: '.interviewcall.club',
        });

        expect(config.secureCookies).toBe(true);
        expect(config.cookieDomain).toBe('.interviewcall.club');
    });

    it('uses host-only cookies when the domain is empty or localhost', () => {
        expect(
            loadIamConfig({ ACCESS_TOKEN_SECRET: SECRET, COOKIE_DOMAIN: '' })
                .cookieDomain,
        ).toBeUndefined();
        expect(
            loadIamConfig({
                ACCESS_TOKEN_SECRET: SECRET,
                COOKIE_DOMAIN: 'localhost',
            }).cookieDomain,
        ).toBeUndefined();
    });

    it('defaults the web origin and drops a trailing slash', () => {
        expect(loadIamConfig({ ACCESS_TOKEN_SECRET: SECRET }).webOrigin).toBe(
            'http://localhost:3002',
        );
        expect(
            loadIamConfig({
                ACCESS_TOKEN_SECRET: SECRET,
                CRM_WEB_ORIGIN: 'https://crm.example.com/',
            }).webOrigin,
        ).toBe('https://crm.example.com');
    });
});
