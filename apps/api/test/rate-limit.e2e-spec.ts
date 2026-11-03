import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { InMemoryIamRepository } from './support/in-memory-iam.repository.js';
import { cheapHash, createTestApp, signIn } from './support/create-test-app.js';

describe('rate limiting (e2e)', () => {
    let app: INestApplication;
    let repository: InMemoryIamRepository;

    // A fresh app per test: every test client shares one IP address, so they must not share counters.
    beforeEach(async () => {
        ({ app, repository } = await createTestApp());
        for (const email of ['one@example.com', 'two@example.com']) {
            repository.add({
                name: email,
                email,
                passwordHash: await cheapHash('right-password-123'),
                role: 'BDA',
                isActive: true,
                mustChangePassword: false,
            });
        }
    });

    afterEach(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app.close();
    });

    it('limits sign-in attempts per address, counting malformed ones too', async () => {
        const server = app.getHttpServer();
        // A malformed body is rejected before any password is hashed, which keeps this fast.
        for (let attempt = 1; attempt <= 60; attempt++) {
            await request(server)
                .post('/api/v1/auth/login')
                .send({})
                .expect(400);
        }

        const blocked = await request(server)
            .post('/api/v1/auth/login')
            .send({})
            .expect(429);

        expect(blocked.body.code).toBe('RATE_LIMITED');
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(900);
    });

    it('limits password changes per signed-in user, not per address', async () => {
        const one = await signIn(app, 'one@example.com', 'right-password-123');
        const two = await signIn(app, 'two@example.com', 'right-password-123');
        const change = (session: typeof one) =>
            session.agent
                .post('/api/v1/auth/password')
                .set('X-CSRF-Token', session.csrf)
                .send({
                    currentPassword: 'wrong-password-123',
                    newPassword: 'a-brand-new-password-1',
                });

        for (let attempt = 1; attempt <= 10; attempt++) {
            const response = await change(one);
            expect([400, 423]).toContain(response.status);
        }
        const blocked = await change(one);

        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('RATE_LIMITED');
        // Same address, different person: not affected.
        expect((await change(two)).status).toBe(400);
    });
});
