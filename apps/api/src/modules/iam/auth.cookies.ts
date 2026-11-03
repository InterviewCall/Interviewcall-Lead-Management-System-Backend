import type { Response } from 'express';
import type { IamConfig } from './iam.config.js';

export const ACCESS_COOKIE = 'crm_access';
export const REFRESH_COOKIE = 'crm_refresh';
export const CSRF_COOKIE = 'crm_csrf';

/** The refresh cookie is only sent to the auth routes (/api/v1 is the global prefix). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Sets the three session cookies: the access and refresh tokens are HttpOnly and unreadable by
 * scripts; the CSRF token is readable so the web app can echo it in the X-CSRF-Token header.
 */
export function setAuthCookies(
    response: Response,
    config: IamConfig,
    tokens: { access: string; refresh: string; csrf: string },
): void {
    const base = {
        sameSite: 'lax' as const,
        secure: config.secureCookies,
        domain: config.cookieDomain,
    };

    response.cookie(ACCESS_COOKIE, tokens.access, {
        ...base,
        httpOnly: true,
        path: '/',
        maxAge: config.accessTtlSeconds * 1000,
    });
    response.cookie(REFRESH_COOKIE, tokens.refresh, {
        ...base,
        httpOnly: true,
        path: REFRESH_COOKIE_PATH,
        maxAge: config.refreshTtlMs,
    });
    response.cookie(CSRF_COOKIE, tokens.csrf, {
        ...base,
        httpOnly: false,
        path: '/',
        maxAge: config.refreshTtlMs,
    });
}
