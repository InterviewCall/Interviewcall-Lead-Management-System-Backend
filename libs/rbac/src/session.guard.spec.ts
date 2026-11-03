import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import {
    ACCESS_TOKEN_ALGORITHM,
    ACCESS_TOKEN_ISSUER,
    accessTokenPayload,
    loadAccessTokenSecret,
} from './access-token.js';
import { AccessTokenVerifier } from './access-token.verifier.js';
import { ALLOW_PASSWORD_CHANGE_KEY } from './decorators/allow-password-change.decorator.js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator.js';
import { REQUIRE_CSRF_KEY } from './decorators/require-csrf.decorator.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import type { Role } from './roles.js';
import { SessionGuard } from './session.guard.js';

const PUBLIC_ID = '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10';

describe('SessionGuard', () => {
    const key = loadAccessTokenSecret({
        ACCESS_TOKEN_SECRET: 'unit-test-secret-unit-test-secret-000',
    });
    const guard = new SessionGuard(
        new Reflector(),
        new AccessTokenVerifier(key),
    );

    /** Signs an access token the way the issuing service does. */
    function sign(role: Role = 'BDA', mustChangePassword = false) {
        return new SignJWT(
            accessTokenPayload({
                publicId: PUBLIC_ID,
                role,
                familyId: 'family-1',
                mustChangePassword,
            }),
        )
            .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM })
            .setSubject(PUBLIC_ID)
            .setIssuer(ACCESS_TOKEN_ISSUER)
            .setExpirationTime('5m')
            .sign(key);
    }

    /** A request context. `routeMeta` is set on the handler, `classMeta` on the controller class. */
    function contextFor(
        request: {
            method?: string;
            cookies?: Record<string, string>;
            headers?: Record<string, string>;
        },
        routeMeta: Record<string, unknown> = {},
        classMeta: Record<string, unknown> = {},
    ) {
        const handler = () => undefined;
        const controller = class {};
        for (const [key, value] of Object.entries(routeMeta))
            Reflect.defineMetadata(key, value, handler);
        for (const [key, value] of Object.entries(classMeta))
            Reflect.defineMetadata(key, value, controller);

        const req = {
            method: request.method ?? 'GET',
            cookies: request.cookies,
            get: (name: string) => request.headers?.[name.toLowerCase()],
            auth: undefined as unknown,
        };
        const context = {
            getType: () => 'http',
            getHandler: () => handler,
            getClass: () => controller,
            switchToHttp: () => ({ getRequest: () => req }),
        } as unknown as ExecutionContext;
        return { context, req };
    }

    const rejection = (promise: Promise<unknown>) =>
        promise.then(
            () => {
                throw new Error('expected the guard to reject');
            },
            (error: { getStatus(): number; getResponse(): unknown }) => ({
                status: error.getStatus(),
                body: error.getResponse(),
            }),
        );

    it('lets a @Public() route through without a session', async () => {
        const { context, req } = contextFor({}, { [IS_PUBLIC_KEY]: true });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(req.auth).toBeUndefined();
    });

    it('answers 401 when there is no access cookie', async () => {
        const { context } = contextFor({ cookies: {} });

        expect(await rejection(guard.canActivate(context))).toEqual({
            status: 401,
            body: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
        });
    });

    it('answers 401 for a bad token, and when cookies were never parsed', async () => {
        const bad = contextFor({ cookies: { crm_access: 'garbage' } });
        const none = contextFor({});

        expect((await rejection(guard.canActivate(bad.context))).status).toBe(
            401,
        );
        expect((await rejection(guard.canActivate(none.context))).status).toBe(
            401,
        );
    });

    it('accepts a valid token on a read and exposes the caller as request.auth', async () => {
        const { context, req } = contextFor({
            cookies: { crm_access: await sign('SALES_MANAGER') },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(req.auth).toEqual({
            publicId: PUBLIC_ID,
            role: 'SALES_MANAGER',
            familyId: 'family-1',
            mustChangePassword: false,
        });
    });

    describe('CSRF', () => {
        it('requires the header on writes', async () => {
            const access = await sign();
            const missing = contextFor({
                method: 'POST',
                cookies: { crm_access: access, crm_csrf: 'abc' },
            });

            expect(
                await rejection(guard.canActivate(missing.context)),
            ).toMatchObject({
                status: 403,
                body: { code: 'CSRF_INVALID' },
            });
        });

        it('rejects a header that differs from the cookie, or a missing cookie', async () => {
            const access = await sign();
            const wrong = contextFor({
                method: 'DELETE',
                cookies: { crm_access: access, crm_csrf: 'abc' },
                headers: { 'x-csrf-token': 'abd' },
            });
            const noCookie = contextFor({
                method: 'POST',
                cookies: { crm_access: access },
                headers: { 'x-csrf-token': 'abc' },
            });

            expect(
                (await rejection(guard.canActivate(wrong.context))).status,
            ).toBe(403);
            expect(
                (await rejection(guard.canActivate(noCookie.context))).status,
            ).toBe(403);
        });

        it('accepts a write whose header matches the cookie', async () => {
            const { context } = contextFor({
                method: 'POST',
                cookies: { crm_access: await sign(), crm_csrf: 'abc' },
                headers: { 'x-csrf-token': 'abc' },
            });

            await expect(guard.canActivate(context)).resolves.toBe(true);
        });

        it('does not ask for the header on reads', async () => {
            for (const method of ['GET', 'HEAD', 'OPTIONS']) {
                const { context } = contextFor({
                    method,
                    cookies: { crm_access: await sign() },
                });
                await expect(guard.canActivate(context)).resolves.toBe(true);
            }
        });
    });

    describe('@RequireCsrf() on a public route', () => {
        const meta = { [IS_PUBLIC_KEY]: true, [REQUIRE_CSRF_KEY]: true };

        it('checks the header even though no session is needed', async () => {
            const { context } = contextFor(
                { method: 'POST', cookies: { crm_csrf: 'abc' } },
                meta,
            );

            expect(await rejection(guard.canActivate(context))).toMatchObject({
                status: 403,
                body: { code: 'CSRF_INVALID' },
            });
        });

        it('lets a matching header through, and a read without one', async () => {
            const write = contextFor(
                {
                    method: 'POST',
                    cookies: { crm_csrf: 'abc' },
                    headers: { 'x-csrf-token': 'abc' },
                },
                meta,
            );
            const read = contextFor({ method: 'GET' }, meta);

            await expect(guard.canActivate(write.context)).resolves.toBe(true);
            await expect(guard.canActivate(read.context)).resolves.toBe(true);
            expect(write.req.auth).toBeUndefined();
        });
    });

    describe('temporary password', () => {
        it('blocks every route except the ones that allow it', async () => {
            const { context } = contextFor({
                cookies: { crm_access: await sign('BDA', true) },
            });

            expect(await rejection(guard.canActivate(context))).toEqual({
                status: 403,
                body: {
                    code: 'PASSWORD_CHANGE_REQUIRED',
                    message: 'Choose a new password before continuing',
                },
            });
        });

        it('lets @AllowPasswordChange() routes through', async () => {
            const { context } = contextFor(
                { cookies: { crm_access: await sign('BDA', true) } },
                { [ALLOW_PASSWORD_CHANGE_KEY]: true },
            );

            await expect(guard.canActivate(context)).resolves.toBe(true);
        });
    });

    describe('roles', () => {
        it('rejects a role that is not listed', async () => {
            const { context } = contextFor(
                { cookies: { crm_access: await sign('BDA') } },
                { [ROLES_KEY]: ['ADMIN'] },
            );

            expect(await rejection(guard.canActivate(context))).toMatchObject({
                status: 403,
                body: { code: 'FORBIDDEN' },
            });
        });

        it('accepts a listed role, set on the route or on the controller', async () => {
            const onRoute = contextFor(
                { cookies: { crm_access: await sign('ADMIN') } },
                { [ROLES_KEY]: ['ADMIN', 'SALES_MANAGER'] },
            );
            const onClass = contextFor(
                { cookies: { crm_access: await sign('ADMIN') } },
                {},
                { [ROLES_KEY]: ['ADMIN'] },
            );
            const classRejects = contextFor(
                { cookies: { crm_access: await sign('CLOSER') } },
                {},
                { [ROLES_KEY]: ['ADMIN'] },
            );

            await expect(guard.canActivate(onRoute.context)).resolves.toBe(
                true,
            );
            await expect(guard.canActivate(onClass.context)).resolves.toBe(
                true,
            );
            expect(
                (await rejection(guard.canActivate(classRejects.context)))
                    .status,
            ).toBe(403);
        });

        it('allows any signed-in role when the route lists none', async () => {
            const { context } = contextFor({
                cookies: { crm_access: await sign('OPS') },
            });

            await expect(guard.canActivate(context)).resolves.toBe(true);
        });
    });
});
