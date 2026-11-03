import { loadAccessTokenSecret } from '@app/rbac';
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
    /** Where the web app lives: the sign-in link in the invite email points here. */
    webOrigin: string;
    secureCookies: boolean;
    /** Fixed by the architecture doc: 10 failed logins lock the account for 15 minutes. */
    maxFailedLogins: number;
    lockMs: number;
}

const envSchema = z.object({
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    COOKIE_DOMAIN: z.string().trim().optional(),
    CRM_WEB_ORIGIN: z.string().trim().default('http://localhost:3002'),
    NODE_ENV: z.string().optional(),
});

/**
 * Reads and checks the auth settings once at startup, so a missing or weak secret stops the
 * app from booting instead of failing on the first login.
 */
export function loadIamConfig(env: NodeJS.ProcessEnv = process.env): IamConfig {
    // The secret is shared with every API that verifies tokens, so the library checks it.
    const accessSecret = loadAccessTokenSecret(env);

    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
        throw new Error(`Invalid auth configuration. ${details}`);
    }

    const values = parsed.data;
    const isProduction = values.NODE_ENV === 'production';

    // Browsers refuse cookies with Domain=localhost, so local development uses host-only cookies.
    const domain =
        values.COOKIE_DOMAIN && values.COOKIE_DOMAIN !== 'localhost'
            ? values.COOKIE_DOMAIN
            : undefined;

    return {
        accessSecret,
        accessTtlSeconds: values.ACCESS_TOKEN_TTL_MINUTES * 60,
        refreshTtlMs: values.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        cookieDomain: domain,
        webOrigin:
            values.CRM_WEB_ORIGIN.replace(/\/+$/, '') ||
            'http://localhost:3002',
        secureCookies: isProduction,
        maxFailedLogins: 10,
        lockMs: 15 * 60 * 1000,
    };
}
