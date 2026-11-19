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
        phone: '98765 43210',
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
                'phone',
                'role',
            ]);
        });

        it('will not create an account without a phone number', async () => {
            const { agent, csrf } = await adminSession();
            const { phone: _phone, ...withoutPhone } = newStaff;

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send(withoutPhone)
                .expect(400);

            expect(response.body.code).toBe('VALIDATION_FAILED');
            expect(Object.keys(response.body.fields)).toEqual(['phone']);
            expect(queue.add).not.toHaveBeenCalled();
        });

        it.each(['', '12345', '5876543210', '98765abcde'])(
            'refuses %j as a phone number, with a message a person can act on',
            async (phone) => {
                const { agent, csrf } = await adminSession();

                const response = await agent
                    .post('/api/v1/staff')
                    .set('X-CSRF-Token', csrf)
                    .send({ ...newStaff, phone })
                    .expect(400);

                expect(response.body.fields.phone).toEqual(expect.any(String));
                expect(
                    repository.accountByEmail('ravi@example.com'),
                ).toBeUndefined();
            },
        );

        it('rejects an email that is already taken', async () => {
            const { agent, csrf } = await adminSession();

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send({
                    name: 'Another Admin',
                    email: ADMIN.email,
                    phone: '9000000099',
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
                    phone: '9000000098',
                    role: 'OPS',
                })
                .expect(503);

            expect(response.body.code).toBe('EMAIL_QUEUE_UNAVAILABLE');
            expect(
                repository.accountByEmail('queue.down@example.com'),
            ).toBeUndefined();
        });
    });

    describe('phone numbers', () => {
        it('refuses a number another person already has, and creates nothing', async () => {
            const { agent, csrf } = await adminSession();
            repository.add({
                name: 'Taken',
                email: 'taken@example.com',
                phone: '+919333333333',
                passwordHash: await cheapHash('taken-password-123'),
                role: 'BDA',
                isActive: true,
                mustChangePassword: false,
            });

            const response = await agent
                .post('/api/v1/staff')
                .set('X-CSRF-Token', csrf)
                .send({
                    name: 'Copy Cat',
                    email: 'copycat@example.com',
                    phone: '+91 93333 33333',
                    role: 'BDA',
                })
                .expect(409);

            expect(response.body.code).toBe('PHONE_ALREADY_IN_USE');
            expect(response.body.fields.phone).toEqual(expect.any(String));
            expect(
                repository.accountByEmail('copycat@example.com'),
            ).toBeUndefined();
            expect(queue.add).not.toHaveBeenCalled();
        });

        describe('saving your own (PATCH /auth/me)', () => {
            const MANAGER = {
                email: 'manager@example.com',
                password: 'manager-password-123',
            };

            beforeAll(async () => {
                repository.add({
                    name: 'Manager',
                    email: MANAGER.email,
                    passwordHash: await cheapHash(MANAGER.password),
                    role: 'SALES_MANAGER',
                    isActive: true,
                    mustChangePassword: false,
                });
            });

            it('needs a session and the CSRF header', async () => {
                await request(app.getHttpServer())
                    .patch('/api/v1/auth/me')
                    .send({ phone: '9444444444' })
                    .expect(401);
                const { agent } = await signIn(
                    app,
                    MANAGER.email,
                    MANAGER.password,
                );
                const response = await agent
                    .patch('/api/v1/auth/me')
                    .send({ phone: '9444444444' })
                    .expect(403);
                expect(response.body.code).toBe('CSRF_INVALID');
            });

            it('lets a manager add their phone number, and /me then shows it', async () => {
                const { agent, csrf, response } = await signIn(
                    app,
                    MANAGER.email,
                    MANAGER.password,
                );
                expect(response.body.user.phone).toBeNull();

                const saved = await agent
                    .patch('/api/v1/auth/me')
                    .set('X-CSRF-Token', csrf)
                    .send({ phone: '94444 44444' })
                    .expect(200);

                expect(saved.body.user).toMatchObject({
                    email: MANAGER.email,
                    role: 'SALES_MANAGER',
                    phone: '+919444444444',
                });
                const me = await agent.get('/api/v1/auth/me').expect(200);
                expect(me.body.user.phone).toBe('+919444444444');
            });

            it('refuses a number a colleague has (409) and a bad one (400)', async () => {
                const { agent, csrf } = await signIn(
                    app,
                    MANAGER.email,
                    MANAGER.password,
                );

                const taken = await agent
                    .patch('/api/v1/auth/me')
                    .set('X-CSRF-Token', csrf)
                    .send({ phone: '9333333333' })
                    .expect(409);
                expect(taken.body.code).toBe('PHONE_ALREADY_IN_USE');

                const bad = await agent
                    .patch('/api/v1/auth/me')
                    .set('X-CSRF-Token', csrf)
                    .send({ phone: '12345' })
                    .expect(400);
                expect(bad.body.fields.phone).toEqual(expect.any(String));

                await agent
                    .patch('/api/v1/auth/me')
                    .set('X-CSRF-Token', csrf)
                    .send({ name: 'Renamed' })
                    .expect(400);
            });
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
                phone: '+919876543210',
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
                phone: '9000000097',
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
                    phone: '9000000096',
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
