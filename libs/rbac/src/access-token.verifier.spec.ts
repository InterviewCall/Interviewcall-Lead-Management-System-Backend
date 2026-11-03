import { SignJWT } from 'jose';
import {
    ACCESS_TOKEN_ALGORITHM,
    ACCESS_TOKEN_ISSUER,
    accessTokenPayload,
    loadAccessTokenSecret,
} from './access-token.js';
import { AccessTokenVerifier } from './access-token.verifier.js';
import type { AuthContext } from './auth-context.js';

const key = loadAccessTokenSecret({
    ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000',
});
const context: AuthContext = {
    publicId: '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10',
    role: 'BDA',
    familyId: 'family-1',
    mustChangePassword: false,
};

function token(
    overrides: {
        issuer?: string;
        secret?: Uint8Array;
        payload?: Record<string, unknown>;
        expires?: string | number;
    } = {},
) {
    return new SignJWT({ ...accessTokenPayload(context), ...overrides.payload })
        .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM })
        .setSubject(context.publicId)
        .setIssuer(overrides.issuer ?? ACCESS_TOKEN_ISSUER)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(overrides.expires ?? '5m')
        .sign(overrides.secret ?? key);
}

describe('AccessTokenVerifier', () => {
    const verifier = new AccessTokenVerifier(key);

    it('returns the caller a valid token names', async () => {
        await expect(verifier.verify(await token())).resolves.toEqual(context);
    });

    it('carries the must-change-password flag', async () => {
        const pending = await token({ payload: { mcp: true } });

        await expect(verifier.verify(pending)).resolves.toMatchObject({
            mustChangePassword: true,
        });
    });

    it('rejects a missing, malformed or tampered token', async () => {
        const valid = await token();

        await expect(verifier.verify(undefined)).resolves.toBeNull();
        await expect(verifier.verify('')).resolves.toBeNull();
        await expect(verifier.verify('not.a.jwt')).resolves.toBeNull();
        await expect(verifier.verify(`${valid}x`)).resolves.toBeNull();
    });

    it('rejects a token signed with a different secret', async () => {
        const other = loadAccessTokenSecret({
            ACCESS_TOKEN_SECRET: 'another-secret-another-secret-0000',
        });

        await expect(
            verifier.verify(await token({ secret: other })),
        ).resolves.toBeNull();
    });

    it('rejects an expired token', async () => {
        await expect(
            verifier.verify(
                await token({ expires: Math.floor(Date.now() / 1000) - 60 }),
            ),
        ).resolves.toBeNull();
    });

    it('rejects a token from another issuer', async () => {
        await expect(
            verifier.verify(await token({ issuer: 'someone-else' })),
        ).resolves.toBeNull();
    });

    it('rejects a token with an unknown role or a missing claim', async () => {
        await expect(
            verifier.verify(await token({ payload: { role: 'SUPERUSER' } })),
        ).resolves.toBeNull();
        await expect(
            verifier.verify(await token({ payload: { fam: undefined } })),
        ).resolves.toBeNull();
        await expect(
            verifier.verify(await token({ payload: { mcp: 'no' } })),
        ).resolves.toBeNull();
    });

    it('rejects a token signed with another algorithm, such as none', async () => {
        const forged = [
            Buffer.from('{"alg":"none"}').toString('base64url'),
            Buffer.from(
                JSON.stringify({
                    ...accessTokenPayload(context),
                    sub: context.publicId,
                    iss: ACCESS_TOKEN_ISSUER,
                }),
            ).toString('base64url'),
            '',
        ].join('.');

        await expect(verifier.verify(forged)).resolves.toBeNull();
    });
});
