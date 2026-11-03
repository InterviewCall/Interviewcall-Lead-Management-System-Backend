import { z } from 'zod';

/** Injection token for the validated auth settings. */
export const IAM_CONFIG = Symbol('IAM_CONFIG');

export interface IamConfig {
    /** HS256 key for access tokens. */
    accessSecret: Uint8Array;
    accessTtlSeconds: number;
    refreshTtlMs: number;
    /** Omitted for host-only cookies (local development). */
    cookieDomain: string | undefined;
    secureCookies: boolean;
    /** Fixed by the architecture doc: 10 failed logins lock the account for 15 minutes. */
    maxFailedLogins: number;
    lockMs: number;
}

const envSchema = z.object({
    ACCESS_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    COOKIE_DOMAIN: z.string().trim().optional(),
    NODE_ENV: z.string().optional(),
});

/**
 * Reads and checks the auth settings once at startup, so a missing or weak secret stops the
 * app from booting instead of failing on the first login.
 */
export function loadIamConfig(env: NodeJS.ProcessEnv = process.env): IamConfig {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
        throw new Error(`Invalid auth configuration. ${details}`);
    }

    const values = parsed.data;
    const isProduction = values.NODE_ENV === 'production';
    if (isProduction && values.ACCESS_TOKEN_SECRET.startsWith('change-me')) {
        throw new Error(
            'Invalid auth configuration. ACCESS_TOKEN_SECRET is still the placeholder from .env.example',
        );
    }

    // Browsers refuse cookies with Domain=localhost, so local development uses host-only cookies.
    const domain =
        values.COOKIE_DOMAIN && values.COOKIE_DOMAIN !== 'localhost'
            ? values.COOKIE_DOMAIN
            : undefined;

    return {
        accessSecret: new TextEncoder().encode(values.ACCESS_TOKEN_SECRET),
        accessTtlSeconds: values.ACCESS_TOKEN_TTL_MINUTES * 60,
        refreshTtlMs: values.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        cookieDomain: domain,
        secureCookies: isProduction,
        maxFailedLogins: 10,
        lockMs: 15 * 60 * 1000,
    };
}
