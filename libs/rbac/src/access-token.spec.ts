import {
    accessTokenPayload,
    authContextFromPayload,
    loadAccessTokenSecret,
} from './access-token.js';
import { ROLES, Role } from './roles.js';

describe('loadAccessTokenSecret', () => {
    it('turns a long enough secret into a key', () => {
        const key = loadAccessTokenSecret({
            ACCESS_TOKEN_SECRET: 'x'.repeat(32),
        });

        expect(key).toBeInstanceOf(Uint8Array);
        expect(key).toHaveLength(32);
    });

    it('refuses a missing or short secret, without printing it', () => {
        expect(() => loadAccessTokenSecret({})).toThrow(/ACCESS_TOKEN_SECRET/);
        expect(() =>
            loadAccessTokenSecret({ ACCESS_TOKEN_SECRET: 'short-secret' }),
        ).toThrow(/at least 32 characters/);
        expect(() =>
            loadAccessTokenSecret({ ACCESS_TOKEN_SECRET: 'short-secret' }),
        ).not.toThrow(/short-secret/);
    });

    it('rejects the .env.example placeholder in production only', () => {
        const env = {
            ACCESS_TOKEN_SECRET: 'change-me-to-a-long-random-string',
        };

        expect(() =>
            loadAccessTokenSecret({ ...env, NODE_ENV: 'production' }),
        ).toThrow(/placeholder/);
        expect(() =>
            loadAccessTokenSecret({ ...env, NODE_ENV: 'development' }),
        ).not.toThrow();
    });
});

describe('token claims', () => {
    const context = {
        publicId: 'p',
        role: Role.CLOSER,
        familyId: 'f',
        mustChangePassword: true,
    };

    it('round-trips through the payload', () => {
        expect(
            authContextFromPayload({
                sub: 'p',
                ...accessTokenPayload(context),
            }),
        ).toEqual(context);
    });

    it('knows every role', () => {
        expect(ROLES).toEqual([
            'BDA',
            'SALES_MANAGER',
            'CLOSER',
            'OPS',
            'ADMIN',
        ]);
    });
});
