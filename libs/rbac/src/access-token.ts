import type { JWTPayload } from 'jose';
import type { AuthContext } from './auth-context.js';
import { ROLES, type Role } from './roles.js';

/**
 * The access-token contract: what a token says and how it is signed. The service that issues
 * tokens (iam) and every API that verifies them depend on this file and nothing else, so
 * switching the signing algorithm or key type is a change made here.
 */
export const ACCESS_TOKEN_ISSUER = 'interviewcall-crm';
export const ACCESS_TOKEN_ALGORITHM = 'HS256';

/** The claims to sign for a caller, besides `sub` (their publicId), `iss`, `iat` and `exp`. */
export function accessTokenPayload(context: AuthContext): {
    role: Role;
    fam: string;
    mcp: boolean;
} {
    return {
        role: context.role,
        fam: context.familyId,
        // "must change password": lets the guard hold the user at the change-password step.
        mcp: context.mustChangePassword,
    };
}

/** Reads a verified token's claims back, or null if any is missing or of the wrong kind. */
export function authContextFromPayload(
    payload: JWTPayload,
): AuthContext | null {
    const { sub, role, fam, mcp } = payload;
    if (
        typeof sub !== 'string' ||
        typeof fam !== 'string' ||
        typeof mcp !== 'boolean' ||
        typeof role !== 'string' ||
        !(ROLES as readonly string[]).includes(role)
    ) {
        return null;
    }
    return {
        publicId: sub,
        role: role as Role,
        familyId: fam,
        mustChangePassword: mcp,
    };
}

/**
 * Reads ACCESS_TOKEN_SECRET, so a missing or weak secret stops the app at boot instead of on
 * the first request. The message never contains the secret.
 */
export function loadAccessTokenSecret(
    env: NodeJS.ProcessEnv = process.env,
): Uint8Array {
    const secret = env.ACCESS_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error(
            'Invalid auth configuration. ACCESS_TOKEN_SECRET: must be at least 32 characters',
        );
    }
    if (env.NODE_ENV === 'production' && secret.startsWith('change-me')) {
        throw new Error(
            'Invalid auth configuration. ACCESS_TOKEN_SECRET is still the placeholder from .env.example',
        );
    }
    return new TextEncoder().encode(secret);
}
