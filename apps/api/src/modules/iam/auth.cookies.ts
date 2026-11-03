import { ACCESS_COOKIE, CSRF_COOKIE } from '@app/rbac';
import type { Response } from 'express';
import type { IamConfig } from './iam.config.js';

/** The access and CSRF cookie names are shared with every API (see @app/rbac); this one is iam's alone. */
export const REFRESH_COOKIE = 'crm_refresh';

/** The refresh cookie is only sent to the auth routes (/api/v1 is the global prefix). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(config: IamConfig) {
    return {
        sameSite: 'lax' as const,
        secure: config.secureCookies,
        domain: config.cookieDomain,
    };
}

/**
 * Sets the session cookies: the access and refresh tokens are HttpOnly and unreadable by
 * scripts; the CSRF token is readable so the web app can echo it in the X-CSRF-Token header.
 * The refresh and CSRF cookies are left alone when they are not in `tokens` (a refresh that
 * only renews the access token).
 */
export function setAuthCookies(
    response: Response,
    config: IamConfig,
    tokens: { access: string; refresh?: string; csrf?: string },
): void {
    const base = baseOptions(config);

    response.cookie(ACCESS_COOKIE, tokens.access, {
        ...base,
        httpOnly: true,
        path: '/',
        maxAge: config.accessTtlSeconds * 1000,
    });
    if (tokens.refresh !== undefined) {
        response.cookie(REFRESH_COOKIE, tokens.refresh, {
            ...base,
            httpOnly: true,
            path: REFRESH_COOKIE_PATH,
            maxAge: config.refreshTtlMs,
        });
    }
    if (tokens.csrf !== undefined) {
        response.cookie(CSRF_COOKIE, tokens.csrf, {
            ...base,
            httpOnly: false,
            path: '/',
            maxAge: config.refreshTtlMs,
        });
    }
}

/** Removes the three cookies. Path and domain must match how they were set. */
export function clearAuthCookies(response: Response, config: IamConfig): void {
    const base = baseOptions(config);
    response.clearCookie(ACCESS_COOKIE, { ...base, httpOnly: true, path: '/' });
    response.clearCookie(REFRESH_COOKIE, {
        ...base,
        httpOnly: true,
        path: REFRESH_COOKIE_PATH,
    });
    response.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, path: '/' });
}
