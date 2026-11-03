import type { INestApplication } from '@nestjs/common';
import type { InMemoryIamRepository } from './support/in-memory-iam.repository.js';
import { cheapHash, createTestApp, signIn } from './support/create-test-app.js';
import request from 'supertest';

const ADMIN = { email: 'admin@example.com', password: 'admin-password-123' };

describe('staff onboarding (e2e)', () => {
    let app: INestApplication;
    let repository: InMemoryIamRepository;
    let queue: Awaited<ReturnType<typeof createTestApp>>['queue'];

    beforeAll(async () => {
        ({ app, repository, queue } = await createTestApp());
        repository.add({
            name: 'Admin',
            email: ADMIN.email,
            passwordHash: await cheapHash(ADMIN.password),
            role: 'ADMIN',
            isActive: true,
            mustChangePassword: false,
        });
    });

    beforeEach(() => {
        queue.add.mockClear();
        queue.ready = Promise.resolve();
    });

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app.close();
    });

    const newStaff = {
        name: 'Ravi Kumar',
        email: 'Ravi@Example.com',
        role: 'CLOSER',
    };

    /** The one-time password the worker would email, read from the queued job. */
    const queuedPassword = (call = 0): string =>
        queue.add.mock.calls[call][1].data.temporaryPassword;

    async function adminSession() {
        const session = await signIn(app, ADMIN.email, ADMIN.password);
        expect(session.response.status).toBe(200);
        return session;
    }

    describe('access', () => {
        it('needs a session', async () => {
            const response = await request(app.getHttpServer())
                .post('/api/v1/staff')
                .send(newStaff)
                .expect(401);

            expect(response.body.code).toBe('UNAUTHENTICATED');
        });

        it('needs the CSRF header on top of the cookies', async () => {
            const { agent } = await adminSession();

            const response = await agent
                .post('/api/v1/staff')
                .send(newStaff)
                .expect(403);

            expect(response.body.code).toBe('CSRF_INVALID');
            expect(queue.add).not.toHaveBeenCalled();
        });

        it('is for admins only', async () => {
            repository.add({
                name: 'Bea',
                email: 'bea@example.com',
                passwordHash: await cheapHash('bea-password-123'),
                role: 'BDA',
                isActive: true,
                mustChangePassword: false,
            });
            const { agent, csrf } = await signIn(
                app,
                'bea@example.com',
                'bea-password-123',
            );

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send(newStaff)
                .expect(403);

            expect(response.body.code).toBe('FORBIDDEN');
        });
    });

    describe('creating staff', () => {
        it('validates the body', async () => {
            const { agent, csrf } = await adminSession();

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send({ name: 'A', email: 'nope', role: 'KING' })
                .expect(400);

            expect(response.body.code).toBe('VALIDATION_FAILED');
            expect(Object.keys(response.body.fields).sort()).toEqual([
                'email',
                'name',
                'role',
            ]);
        });

        it('rejects an email that is already taken', async () => {
            const { agent, csrf } = await adminSession();

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send({
                    name: 'Another Admin',
                    email: ADMIN.email,
                    role: 'ADMIN',
                })
                .expect(409);

            expect(response.body.code).toBe('EMAIL_ALREADY_EXISTS');
            expect(JSON.stringify(response.body)).not.toContain(ADMIN.email);
            expect(queue.add).not.toHaveBeenCalled();
        });

        it('leaves no account behind when the email cannot be queued', async () => {
            // Redis is unreachable: the queue never becomes ready.
            queue.ready = new Promise<void>(() => undefined);
            const { agent, csrf } = await adminSession();

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send({
                    name: 'Queue Down',
                    email: 'queue.down@example.com',
                    role: 'OPS',
                })
                .expect(503);

            expect(response.body.code).toBe('EMAIL_QUEUE_UNAVAILABLE');
            expect(
                repository.accountByEmail('queue.down@example.com'),
            ).toBeUndefined();
        });
    });

    it('takes a new staff member from invite to active account', async () => {
        // 1. The admin creates the account. The response carries no password.
        const admin = await adminSession();
        const created = await admin.agent
            .post('/api/v1/staff')
            .set('X-CSRF-Token', admin.csrf)
            .send(newStaff)
            .expect(201);

        const staffId: string = created.body.staff.id;
        expect(created.body).toEqual({
            staff: {
                id: staffId,
                name: 'Ravi Kumar',
                email: 'ravi@example.com',
                role: 'CLOSER',
                status: 'PENDING',
            },
        });
        expect(JSON.stringify(created.body)).not.toContain(queuedPassword());

        // 2. One email is queued, addressed to the new account, carrying the one-time password.
        expect(queue.add).toHaveBeenCalledTimes(1);
        const [jobName, message] = queue.add.mock.calls[0];
        expect(jobName).toBe('send');
        expect(message).toMatchObject({
            channel: 'EMAIL',
            recipient: 'ravi@example.com',
            template: 'staff-invite',
            data: {
                name: 'Ravi Kumar',
                role: 'Closer',
                loginUrl: 'http://localhost:3002/login',
            },
        });
        const temporaryPassword = queuedPassword();

        // 3. They sign in with it, and are told to change it.
        const first = await signIn(app, 'ravi@example.com', temporaryPassword);
        expect(first.response.status).toBe(200);
        expect(first.response.body.user).toMatchObject({
            role: 'CLOSER',
            mustChangePassword: true,
        });

        // 4. Until they do, everything else is closed to them.
        const blocked = await first.agent
            .post('/api/v1/staff')
            .set('X-CSRF-Token', first.csrf)
            .send({
                name: 'Someone',
                email: 'someone@example.com',
                role: 'BDA',
            })
            .expect(403);
        expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

        // 5. A wrong current password, a weak new one and an unchanged one are all refused.
        const attempt = (body: object) =>
            first.agent
                .post('/api/v1/auth/password')
                .set('X-CSRF-Token', first.csrf)
                .send(body);

        const wrongCurrent = await attempt({
            currentPassword: 'guess',
            newPassword: 'my-own-new-password',
        }).expect(400);
        expect(wrongCurrent.body.fields).toEqual({
            currentPassword: 'Current password is incorrect',
        });
        const weak = await attempt({
            currentPassword: temporaryPassword,
            newPassword: 'short',
        }).expect(400);
        expect(weak.body.fields).toEqual({
            newPassword: 'Use at least 10 characters',
        });
        const same = await attempt({
            currentPassword: temporaryPassword,
            newPassword: temporaryPassword,
        }).expect(400);
        expect(same.body.fields).toEqual({
            newPassword: 'Choose a password different from the current one',
        });
        expect(
            repository.accountByEmail('ravi@example.com')!.mustChangePassword,
        ).toBe(true);

        // 6. Choosing their own password activates the account and gives them fresh cookies.
        const changed = await attempt({
            currentPassword: temporaryPassword,
            newPassword: 'my-own-new-password',
        }).expect(200);
        expect(changed.body.user.mustChangePassword).toBe(false);
        expect(changed.headers['set-cookie']).toHaveLength(3);

        const account = repository.accountByEmail('ravi@example.com')!;
        expect(account.mustChangePassword).toBe(false);
        expect(repository.activeSessions(account.id)).toHaveLength(1);
        expect(
            repository.sessions.filter(
                (s) => s.userId === account.id && s.revokedAt,
            ),
        ).toHaveLength(1);

        // 7. The temporary password no longer works; the chosen one does and needs no change.
        const old = await signIn(app, 'ravi@example.com', temporaryPassword);
        expect(old.response.status).toBe(401);
        const second = await signIn(
            app,
            'ravi@example.com',
            'my-own-new-password',
        );
        expect(second.response.status).toBe(200);
        expect(second.response.body.user.mustChangePassword).toBe(false);

        // 8. Active, but still a closer: the admin-only route stays closed.
        const forbidden = await second.agent
            .post('/api/v1/staff')
            .set('X-CSRF-Token', second.csrf)
            .send(newStaff)
            .expect(403);
        expect(forbidden.body.code).toBe('FORBIDDEN');
    });

    describe('reset password', () => {
        it('replaces the password, ends sessions and emails a new one', async () => {
            const admin = await adminSession();
            const created = await admin.agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', admin.csrf)
                .send({
                    name: 'Mina Das',
                    email: 'mina@example.com',
                    role: 'BDA',
                })
                .expect(201);
            const firstPassword = queuedPassword();
            const mina = await signIn(app, 'mina@example.com', firstPassword);
            expect(mina.response.status).toBe(200);
            const account = repository.accountByEmail('mina@example.com')!;
            expect(repository.activeSessions(account.id)).toHaveLength(1);

            const reset = await admin.agent
                .post(`/api/v1/staff/${created.body.staff.id}/reset-password`)
                .set('X-CSRF-Token', admin.csrf)
                .expect(200);

            expect(reset.body.staff).toMatchObject({
                email: 'mina@example.com',
                status: 'PENDING',
            });
            expect(queue.add).toHaveBeenCalledTimes(2);
            expect(repository.activeSessions(account.id)).toHaveLength(0);
            const nextPassword = queuedPassword(1);
            expect(nextPassword).not.toBe(firstPassword);

            expect(
                (await signIn(app, 'mina@example.com', firstPassword)).response
                    .status,
            ).toBe(401);
            const again = await signIn(app, 'mina@example.com', nextPassword);
            expect(again.response.body.user.mustChangePassword).toBe(true);
        });

        it('answers 404 for an unknown account and 400 for a malformed id', async () => {
            const admin = await adminSession();

            const missing = await admin.agent
                .post(
                    '/api/v1/staff/0c4c59f3-1b0e-4f55-9a43-0c1a0d0d7c11/reset-password',
                )
                .set('X-CSRF-Token', admin.csrf)
                .expect(404);
            expect(missing.body.code).toBe('STAFF_NOT_FOUND');

            const malformed = await admin.agent
                .post('/api/v1/staff/12/reset-password')
                .set('X-CSRF-Token', admin.csrf)
                .expect(400);
            expect(malformed.body).toEqual({
                code: 'VALIDATION_FAILED',
                message: 'Invalid staff id',
            });
        });
    });
});
