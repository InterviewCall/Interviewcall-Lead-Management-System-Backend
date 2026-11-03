import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { InMemoryIamRepository } from './support/in-memory-iam.repository.js';
import {
    cheapHash,
    createTestApp,
    WEB_ORIGIN,
} from './support/create-test-app.js';

describe('POST /api/v1/auth/login (e2e)', () => {
    let app: INestApplication;
    let repository: InMemoryIamRepository;

    beforeAll(async () => {
        ({ app, repository } = await createTestApp());
        repository.add({
            name: 'Asha Rao',
            email: 'asha@example.com',
            passwordHash: await cheapHash('correct-password'),
            role: 'ADMIN',
            isActive: true,
            mustChangePassword: false,
        });
    });

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app.close();
    });

    const login = (body?: unknown) => {
        const call = request(app.getHttpServer()).post('/api/v1/auth/login');
        return body === undefined ? call : call.send(body as object);
    };

    it('signs in: 200, the user in the body, the tokens only in cookies', async () => {
        const response = await login({
            email: '  Asha@Example.com ',
            password: 'correct-password',
        }).expect(200);

        expect(response.body).toEqual({
            user: {
                id: repository.accountByEmail('asha@example.com')!.publicId,
                name: 'Asha Rao',
                email: 'asha@example.com',
                role: 'ADMIN',
                mustChangePassword: false,
            },
        });
        expect(Object.keys(response.body)).toEqual(['user']);

        const cookies = response.headers['set-cookie'] as unknown as string[];
        const byName = (name: string) =>
            cookies.find((cookie) => cookie.startsWith(`${name}=`))!;
        expect(cookies).toHaveLength(3);
        expect(byName('crm_access')).toMatch(
            /Path=\/;.*HttpOnly.*SameSite=Lax/,
        );
        expect(byName('crm_refresh')).toMatch(
            /Path=\/api\/v1\/auth;.*HttpOnly.*SameSite=Lax/,
        );
        expect(byName('crm_csrf')).not.toMatch(/HttpOnly/);
        expect(byName('crm_csrf')).toMatch(/SameSite=Lax/);
    });

    it('stores the session as a hash: the refresh cookie value is not in the store', async () => {
        const response = await login({
            email: 'asha@example.com',
            password: 'correct-password',
        });
        const refresh = (response.headers['set-cookie'] as unknown as string[])
            .find((cookie) => cookie.startsWith('crm_refresh='))!
            .slice('crm_refresh='.length)
            .split(';')[0];

        const stored = repository.sessions.map((session) => session.tokenHash);
        expect(stored).not.toContain(refresh);
        expect(stored.at(-1)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('answers 401 INVALID_CREDENTIALS and sets no cookie for a wrong password', async () => {
        const response = await login({
            email: 'asha@example.com',
            password: 'nope',
        }).expect(401);

        expect(response.body).toEqual({
            code: 'INVALID_CREDENTIALS',
            message: 'Email or password is incorrect',
        });
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('gives an unknown email the same answer as a wrong password', async () => {
        const response = await login({
            email: 'ghost@example.com',
            password: 'whatever',
        }).expect(401);

        expect(response.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('answers 423 ACCOUNT_LOCKED while the account is locked', async () => {
        const locked = repository.add({
            name: 'Locked',
            email: 'locked@example.com',
            passwordHash: await cheapHash('correct-password'),
            role: 'BDA',
            isActive: true,
            mustChangePassword: false,
            lockedUntil: new Date(Date.now() + 5 * 60_000),
        });

        const response = await login({
            email: locked.email,
            password: 'correct-password',
        }).expect(423);

        expect(response.body.code).toBe('ACCOUNT_LOCKED');
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('answers 400 VALIDATION_FAILED with a message per field', async () => {
        const response = await login({
            email: 'not-an-email',
            password: '',
        }).expect(400);

        expect(response.body).toEqual({
            code: 'VALIDATION_FAILED',
            message: 'Some fields are invalid',
            fields: {
                email: 'Enter a valid email',
                password: 'Enter your password',
            },
        });
    });

    it('does not echo what was sent, and reports a missing field', async () => {
        const response = await login({ email: 'asha@example.com' }).expect(400);

        expect(response.body.fields).toEqual({
            password: 'Enter your password',
        });
        expect(JSON.stringify(response.body)).not.toContain('asha@example.com');
    });

    it('answers 400 when there is no JSON body at all', async () => {
        const response = await login().expect(400);

        expect(response.body).toEqual({
            code: 'VALIDATION_FAILED',
            message: 'Send a JSON body with email and password',
        });
    });

    it('answers 400 in the same error shape for malformed JSON', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .set('Content-Type', 'application/json')
            .send('{"email": ')
            .expect(400);

        expect(response.body).toEqual({
            code: 'BAD_REQUEST',
            message: expect.any(String),
        });
    });

    it('shapes unknown routes like every other error', async () => {
        const response = await request(app.getHttpServer())
            .get('/api/v1/nope')
            .expect(404);

        expect(response.body).toEqual({
            code: 'NOT_FOUND',
            message: expect.any(String),
        });
    });

    it('allows credentialed requests only from the configured web origin', async () => {
        const preflight = (origin: string) =>
            request(app.getHttpServer())
                .options('/api/v1/auth/login')
                .set('Origin', origin)
                .set('Access-Control-Request-Method', 'POST');

        const allowed = await preflight(WEB_ORIGIN);
        expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
        expect(allowed.headers['access-control-allow-credentials']).toBe(
            'true',
        );

        const other = await preflight('https://evil.example');
        // The header names the configured origin only, so a browser on any other origin is refused.
        expect(other.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    });
});
