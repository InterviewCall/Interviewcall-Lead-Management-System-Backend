import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { ModelService } from '@app/model';
import { IamRepository } from '../src/modules/iam/iam.repository.js';
import type { StaffAccount } from '../src/modules/iam/iam.types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

describe('POST /api/v1/auth/login (e2e)', () => {
    let app: INestApplication;
    let account: StaffAccount;
    const repository = {
        findStaffByEmail: vi.fn(),
        recordFailedLogin: vi.fn(),
        recordSuccessfulLogin: vi.fn(),
    };

    beforeAll(async () => {
        account = {
            id: 7n,
            publicId: '5a1d1c1e-9a6f-4f6e-8a55-0d7c2a3b9e10',
            name: 'Asha Rao',
            email: 'asha@example.com',
            passwordHash: await argon2.hash('correct-password', {
                type: argon2.argon2id,
                memoryCost: 1024,
                timeCost: 2,
                parallelism: 1,
            }),
            role: 'ADMIN',
            isActive: true,
            mustChangePassword: false,
            lockedUntil: null,
        };

        const moduleRef = await Test.createTestingModule({
            imports: [AppModule],
        })
            // No database in e2e: the module is real, only the two edges to MySQL are replaced.
            .overrideProvider(ModelService)
            .useValue({})
            .overrideProvider(IamRepository)
            .useValue(repository)
            .compile();

        process.env.CRM_WEB_ORIGIN = 'http://localhost:3002';
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
    });

    beforeEach(() => {
        vi.resetAllMocks();
        repository.findStaffByEmail.mockResolvedValue(account);
        repository.recordFailedLogin.mockResolvedValue(false);
        repository.recordSuccessfulLogin.mockResolvedValue(undefined);
    });

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app.close();
    });

    const login = (body: unknown) =>
        request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send(body as object);

    it('signs in: 200, the user in the body, the tokens only in cookies', async () => {
        const response = await login({
            email: '  Asha@Example.com ',
            password: 'correct-password',
        }).expect(200);

        expect(repository.findStaffByEmail).toHaveBeenCalledWith(
            'asha@example.com',
        );
        expect(response.body).toEqual({
            user: {
                id: account.publicId,
                name: 'Asha Rao',
                email: 'asha@example.com',
                role: 'ADMIN',
                mustChangePassword: false,
            },
        });
        expect(Object.keys(response.body)).toEqual(['user']);
        expect(JSON.stringify(response.body)).not.toContain(
            account.passwordHash,
        );

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
        expect(repository.recordFailedLogin).toHaveBeenCalledTimes(1);
    });

    it('answers 423 ACCOUNT_LOCKED while the account is locked', async () => {
        repository.findStaffByEmail.mockResolvedValue({
            ...account,
            lockedUntil: new Date(Date.now() + 5 * 60_000),
        });

        const response = await login({
            email: 'asha@example.com',
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
        expect(repository.findStaffByEmail).not.toHaveBeenCalled();
    });

    it('does not echo what was sent, and reports a missing field', async () => {
        const response = await login({ email: 'asha@example.com' }).expect(400);

        expect(response.body.fields).toEqual({
            password: 'Enter your password',
        });
        expect(JSON.stringify(response.body)).not.toContain('asha@example.com');
    });

    it('answers 400 when there is no JSON body at all', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .expect(400);

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

        const allowed = await preflight('http://localhost:3002');
        expect(allowed.headers['access-control-allow-origin']).toBe(
            'http://localhost:3002',
        );
        expect(allowed.headers['access-control-allow-credentials']).toBe(
            'true',
        );

        const other = await preflight('https://evil.example');
        // The header names the configured origin only, so a browser on any other origin is refused.
        expect(other.headers['access-control-allow-origin']).toBe(
            'http://localhost:3002',
        );
    });
});
