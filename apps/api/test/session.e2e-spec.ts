import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { AuditAction } from '../src/modules/admin/audit.types.js';
import type { InMemoryAdminRepository } from './support/in-memory-admin.repository.js';
import type { InMemoryIamRepository } from './support/in-memory-iam.repository.js';
import {
    cheapHash,
    cookieValue,
    createTestApp,
    signIn,
} from './support/create-test-app.js';

const USER = { email: 'asha@example.com', password: 'asha-password-123' };

describe('refresh, logout and me (e2e)', () => {
    let app: INestApplication;
    let repository: InMemoryIamRepository;
    let admin: InMemoryAdminRepository;

    beforeAll(async () => {
        ({ app, repository, admin } = await createTestApp());
        repository.add({
            name: 'Asha Rao',
            email: USER.email,
            passwordHash: await cheapHash(USER.password),
            role: 'BDA',
            isActive: true,
            mustChangePassword: false,
        });
    });

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app.close();
    });

    afterEach(() => {
        vi.useRealTimers();
        // A test may leave the account switched off or with another role.
        Object.assign(repository.accountByEmail(USER.email)!, {
            isActive: true,
            role: 'BDA',
        });
    });

    /** Signs in and returns the three cookie values the browser would now hold. */
    async function login() {
        const session = await signIn(app, USER.email, USER.password);
        expect(session.response.status).toBe(200);
        const cookies = session.response.headers['set-cookie'];
        return {
            access: cookieValue(cookies, 'crm_access')!,
            refresh: cookieValue(cookies, 'crm_refresh')!,
            csrf: cookieValue(cookies, 'crm_csrf')!,
        };
    }

    /** A request carrying exactly these cookies, like a browser that holds them. */
    function send(
        method: 'get' | 'post',
        path: string,
        cookies: Record<string, string | undefined>,
        csrf?: string,
    ) {
        const header = Object.entries(cookies)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => `${name}=${value}`);
        const call = request(app.getHttpServer())
            [method](path)
            .set('Cookie', header);
        return csrf ? call.set('X-CSRF-Token', csrf) : call;
    }

    const refresh = (
        tokens: { refresh?: string; csrf: string },
        csrf?: string,
    ) =>
        send(
            'post',
            '/api/v1/auth/refresh',
            { crm_refresh: tokens.refresh, crm_csrf: tokens.csrf },
            csrf ?? tokens.csrf,
        );

    describe('GET /auth/me', () => {
        it('needs a session', async () => {
            const response = await request(app.getHttpServer())
                .get('/api/v1/auth/me')
                .expect(401);

            expect(response.body.code).toBe('UNAUTHENTICATED');
        });

        it('returns the signed-in user, fresh from the database', async () => {
            const tokens = await login();
            repository.accountByEmail(USER.email)!.role = 'OPS';

            const response = await send('get', '/api/v1/auth/me', {
                crm_access: tokens.access,
            }).expect(200);

            expect(response.body).toEqual({
                user: {
                    id: expect.any(String),
                    name: 'Asha Rao',
                    email: USER.email,
                    role: 'OPS',
                    mustChangePassword: false,
                },
            });
        });

        it('answers an account that still has a temporary password, so the app can show the change screen', async () => {
            const pending = repository.add({
                name: 'New Person',
                email: 'new@example.com',
                passwordHash: await cheapHash('temp-password-1'),
                role: 'CLOSER',
                isActive: true,
                mustChangePassword: true,
            });
            const session = await signIn(app, pending.email, 'temp-password-1');

            const response = await session.agent
                .get('/api/v1/auth/me')
                .expect(200);

            expect(response.body.user.mustChangePassword).toBe(true);
        });

        it('stops answering once the account is deactivated, though the token is still valid', async () => {
            const tokens = await login();
            repository.accountByEmail(USER.email)!.isActive = false;

            await send('get', '/api/v1/auth/me', {
                crm_access: tokens.access,
            }).expect(401);
        });
    });

    describe('POST /auth/refresh', () => {
        it('needs the CSRF header even though no access token is needed', async () => {
            const tokens = await login();

            const response = await send(
                'post',
                '/api/v1/auth/refresh',
                { crm_refresh: tokens.refresh, crm_csrf: tokens.csrf },
                'not-the-token',
            ).expect(403);

            expect(response.body.code).toBe('CSRF_INVALID');
        });

        it('answers 401 without a refresh cookie, or with one nobody issued', async () => {
            const tokens = await login();

            await refresh({ csrf: tokens.csrf }).expect(401);
            await refresh({ refresh: 'made-up', csrf: tokens.csrf }).expect(
                401,
            );
        });

        it('swaps the refresh token for a new one and sets all three cookies again', async () => {
            const tokens = await login();

            const response = await refresh(tokens).expect(200);

            const cookies = response.headers['set-cookie'];
            expect(response.body.user.email).toBe(USER.email);
            expect(cookieValue(cookies, 'crm_access')).toBeTruthy();
            expect(cookieValue(cookies, 'crm_refresh')).toBeTruthy();
            expect(cookieValue(cookies, 'crm_refresh')).not.toBe(
                tokens.refresh,
            );
            expect(cookieValue(cookies, 'crm_csrf')).not.toBe(tokens.csrf);
            // The refresh cookie only travels to the auth routes.
            expect(
                (cookies as unknown as string[]).find((c) =>
                    c.startsWith('crm_refresh='),
                ),
            ).toContain('Path=/api/v1/auth');
            expect(JSON.stringify(response.body)).not.toContain(
                cookieValue(cookies, 'crm_refresh')!,
            );
        });

        it('hands out an access token that works, in the same sign-in', async () => {
            const tokens = await login();
            const next = (await refresh(tokens).expect(200)).headers[
                'set-cookie'
            ];

            await send('get', '/api/v1/auth/me', {
                crm_access: cookieValue(next, 'crm_access'),
            }).expect(200);
            expect(decodeJwt(cookieValue(next, 'crm_access')!).fam).toBe(
                decodeJwt(tokens.access).fam,
            );
        });

        it('lets a role change through into the next access token', async () => {
            const tokens = await login();
            repository.accountByEmail(USER.email)!.role = 'CLOSER';

            const response = await refresh(tokens).expect(200);

            expect(
                decodeJwt(
                    cookieValue(response.headers['set-cookie'], 'crm_access')!,
                ).role,
            ).toBe('CLOSER');
        });

        it('treats a second tab using the same token a moment later as the same user', async () => {
            const tokens = await login();
            await refresh(tokens).expect(200);

            const second = await refresh(tokens).expect(200);

            const cookies = second.headers['set-cookie'];
            expect(cookieValue(cookies, 'crm_access')).toBeTruthy();
            // The first tab already got the replacement; this one must not overwrite it.
            expect(cookieValue(cookies, 'crm_refresh')).toBeUndefined();
            expect(cookieValue(cookies, 'crm_csrf')).toBeUndefined();
        });

        it('ends the whole sign-in when an old token is replayed later, and records it', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            const tokens = await login();
            const next = (await refresh(tokens).expect(200)).headers[
                'set-cookie'
            ];
            const newest = {
                refresh: cookieValue(next, 'crm_refresh'),
                csrf: cookieValue(next, 'crm_csrf')!,
            };

            vi.setSystemTime(Date.now() + 11_000);
            await refresh(tokens).expect(401);

            // The legitimate holder's token died with it.
            await refresh(newest).expect(401);
            expect(
                admin.byAction(AuditAction.RefreshReuseDetected),
            ).toHaveLength(1);
        });

        it('refuses a deactivated account and ends that sign-in', async () => {
            const tokens = await login();
            repository.accountByEmail(USER.email)!.isActive = false;

            await refresh(tokens).expect(401);

            const stored = repository.sessions.find(
                (session) =>
                    session.tokenHash ===
                    createHash('sha256').update(tokens.refresh!).digest('hex'),
            );
            expect(stored?.revokedAt).toBeTruthy();
        });
    });

    describe('POST /auth/logout', () => {
        it('needs the CSRF header', async () => {
            const tokens = await login();

            const response = await send('post', '/api/v1/auth/logout', {
                crm_refresh: tokens.refresh,
                crm_csrf: tokens.csrf,
            }).expect(403);

            expect(response.body.code).toBe('CSRF_INVALID');
        });

        it('ends the sign-in, clears the cookies and kills the refresh token', async () => {
            const tokens = await login();

            const response = await send(
                'post',
                '/api/v1/auth/logout',
                {
                    crm_access: tokens.access,
                    crm_refresh: tokens.refresh,
                    crm_csrf: tokens.csrf,
                },
                tokens.csrf,
            ).expect(204);

            const cleared = response.headers[
                'set-cookie'
            ] as unknown as string[];
            for (const name of ['crm_access', 'crm_refresh', 'crm_csrf']) {
                const line = cleared.find((c) => c.startsWith(`${name}=`));
                expect(line).toContain('Expires=Thu, 01 Jan 1970');
            }
            await refresh(tokens).expect(401);
            // The access token has not expired, but /me notices the sign-in is over.
            await send('get', '/api/v1/auth/me', {
                crm_access: tokens.access,
            }).expect(401);
        });

        it('works after the access token has expired, with only the refresh cookie', async () => {
            const tokens = await login();

            await send(
                'post',
                '/api/v1/auth/logout',
                { crm_refresh: tokens.refresh, crm_csrf: tokens.csrf },
                tokens.csrf,
            ).expect(204);

            await refresh(tokens).expect(401);
        });

        it('is harmless to repeat, and records the logout once', async () => {
            const before = admin.byAction(AuditAction.Logout).length;
            const tokens = await login();
            const logout = () =>
                send(
                    'post',
                    '/api/v1/auth/logout',
                    { crm_refresh: tokens.refresh, crm_csrf: tokens.csrf },
                    tokens.csrf,
                ).expect(204);

            await logout();
            await logout();

            expect(admin.byAction(AuditAction.Logout)).toHaveLength(before + 1);
        });

        it('succeeds with no cookies at all', async () => {
            await send(
                'post',
                '/api/v1/auth/logout',
                { crm_csrf: 'x' },
                'x',
            ).expect(204);
        });

        it('leaves other sign-ins of the same person alone', async () => {
            const laptop = await login();
            const phone = await login();

            await send(
                'post',
                '/api/v1/auth/logout',
                { crm_refresh: laptop.refresh, crm_csrf: laptop.csrf },
                laptop.csrf,
            ).expect(204);

            await refresh(phone).expect(200);
        });
    });

    describe('audit trail', () => {
        it('records sign-ins by account and address, never by email or password', async () => {
            await login();
            await signIn(app, USER.email, 'wrong-password-123');

            const lines = JSON.stringify(admin.audits, (_k, v) =>
                typeof v === 'bigint' ? v.toString() : v,
            );
            expect(
                admin.byAction(AuditAction.LoginSucceeded).length,
            ).toBeGreaterThan(0);
            expect(
                admin.byAction(AuditAction.LoginFailed).length,
            ).toBeGreaterThan(0);
            expect(lines).not.toContain(USER.email);
            expect(lines).not.toContain(USER.password);
            expect(lines).not.toContain('wrong-password-123');
        });
    });
});
