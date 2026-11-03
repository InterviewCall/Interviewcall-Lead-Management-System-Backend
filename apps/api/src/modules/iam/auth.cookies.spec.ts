import type { Response } from 'express';
import { ACCESS_COOKIE, CSRF_COOKIE } from '@app/rbac';
import {
    REFRESH_COOKIE,
    REFRESH_COOKIE_PATH,
    setAuthCookies,
} from './auth.cookies.js';
import { loadIamConfig } from './iam.config.js';

describe('setAuthCookies', () => {
    const tokens = { access: 'a', refresh: 'r', csrf: 'c' };

    function run(env: NodeJS.ProcessEnv) {
        const cookie = vi.fn();
        setAuthCookies(
            { cookie } as unknown as Response,
            loadIamConfig(env),
            tokens,
        );
        return Object.fromEntries(
            cookie.mock.calls.map(([name, value, options]) => [
                name,
                { value, options },
            ]),
        );
    }

    it('keeps both tokens HttpOnly and the CSRF token readable', () => {
        const cookies = run({
            ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000',
        });

        expect(cookies[ACCESS_COOKIE].options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 900_000,
        });
        expect(cookies[REFRESH_COOKIE].options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: REFRESH_COOKIE_PATH,
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        expect(cookies[CSRF_COOKIE].options).toMatchObject({
            httpOnly: false,
            sameSite: 'lax',
            path: '/',
        });
    });

    it('adds Secure and the shared domain in production', () => {
        const cookies = run({
            ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000',
            NODE_ENV: 'production',
            COOKIE_DOMAIN: '.interviewcall.club',
        });

        for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
            expect(cookies[name].options).toMatchObject({
                secure: true,
                domain: '.interviewcall.club',
            });
        }
    });
});
