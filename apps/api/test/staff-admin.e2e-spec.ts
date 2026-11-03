import type { INestApplication } from '@nestjs/common';
import { AuditAction } from '../src/modules/admin/audit.types.js';
import type { InMemoryAdminRepository } from './support/in-memory-admin.repository.js';
import type { InMemoryIamRepository } from './support/in-memory-iam.repository.js';
import { cheapHash, createTestApp, signIn } from './support/create-test-app.js';

const ADMIN = { email: 'admin@example.com', password: 'admin-password-123' };
const SECOND_ADMIN = {
    email: 'admin2@example.com',
    password: 'admin2-password-123',
};
const BDA = { email: 'asha@example.com', password: 'asha-password-123' };
const UUID_UNKNOWN = '99999999-9999-4999-8999-999999999999';

describe('staff administration (e2e)', () => {
    let app: INestApplication;
    let repository: InMemoryIamRepository;
    let admin: InMemoryAdminRepository;
    let queue: Awaited<ReturnType<typeof createTestApp>>['queue'];

    const staffId = (email: string) =>
        repository.accountByEmail(email)!.publicId;

    beforeAll(async () => {
        ({ app, repository, admin, queue } = await createTestApp());
        const make = async (
            name: string,
            email: string,
            password: string,
            role: 'ADMIN' | 'BDA' | 'CLOSER' | 'OPS' | 'SALES_MANAGER',
            mustChangePassword = false,
        ) =>
            repository.add({
                name,
                email,
                passwordHash: await cheapHash(password),
                role,
                isActive: true,
                mustChangePassword,
            });
        await make('Admin', ADMIN.email, ADMIN.password, 'ADMIN');
        await make(
            'Second Admin',
            SECOND_ADMIN.email,
            SECOND_ADMIN.password,
            'ADMIN',
        );
        await make('Asha Rao', BDA.email, BDA.password, 'BDA');
        await make(
            'Ravi Kumar',
            'ravi@example.com',
            'ravi-password-123',
            'CLOSER',
        );
        await make(
            'Meera Das',
            'meera@example.com',
            'meera-password-123',
            'OPS',
            true,
        );
    });

    beforeEach(() => {
        queue.add.mockClear();
        queue.ready = Promise.resolve();
    });

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app.close();
    });

    async function asAdmin(account = ADMIN) {
        const session = await signIn(app, account.email, account.password);
        expect(session.response.status).toBe(200);
        return session;
    }

    describe('GET /staff', () => {
        it('is for admins only', async () => {
            const bda = await signIn(app, BDA.email, BDA.password);

            const forbidden = await bda.agent.get('/api/v1/staff').expect(403);
            expect(forbidden.body.code).toBe('FORBIDDEN');
            await (
                await import('supertest')
            )
                .default(app.getHttpServer())
                .get('/api/v1/staff')
                .expect(401);
        });

        it('lists newest first with status, dates and paging, and no secrets', async () => {
            const { agent } = await asAdmin();

            const response = await agent.get('/api/v1/staff').expect(200);

            expect(response.body.total).toBe(5);
            expect(response.body.page).toBe(1);
            expect(response.body.pageSize).toBe(25);
            expect(response.body.staff.map((s: any) => s.name)).toEqual([
                'Meera Das',
                'Ravi Kumar',
                'Asha Rao',
                'Second Admin',
                'Admin',
            ]);
            expect(response.body.staff[0]).toEqual({
                id: expect.any(String),
                name: 'Meera Das',
                email: 'meera@example.com',
                role: 'OPS',
                status: 'PENDING',
                createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                lastLoginAt: null,
            });
            expect(JSON.stringify(response.body)).not.toMatch(/hash|argon2/i);
        });

        it('filters by status, role and search', async () => {
            const { agent } = await asAdmin();
            const names = async (query: string) =>
                (
                    await agent.get(`/api/v1/staff?${query}`).expect(200)
                ).body.staff.map((s: any) => s.name);

            expect(await names('status=PENDING')).toEqual(['Meera Das']);
            expect(await names('role=ADMIN')).toEqual([
                'Second Admin',
                'Admin',
            ]);
            expect(await names('search=rav')).toEqual(['Ravi Kumar']);
            expect(await names('search=EXAMPLE.COM&role=BDA')).toEqual([
                'Asha Rao',
            ]);
            expect(await names('status=DEACTIVATED')).toEqual([]);
        });

        it('pages through the results', async () => {
            const { agent } = await asAdmin();

            const second = await agent
                .get('/api/v1/staff?pageSize=2&page=2')
                .expect(200);

            expect(second.body).toMatchObject({
                page: 2,
                pageSize: 2,
                total: 5,
            });
            expect(second.body.staff.map((s: any) => s.name)).toEqual([
                'Asha Rao',
                'Second Admin',
            ]);
        });

        it('rejects a bad query with the field named', async () => {
            const { agent } = await asAdmin();

            const response = await agent
                .get('/api/v1/staff?pageSize=500&status=NOPE')
                .expect(400);

            expect(response.body.code).toBe('VALIDATION_FAILED');
            expect(Object.keys(response.body.fields).sort()).toEqual([
                'pageSize',
                'status',
            ]);
        });
    });

    describe('PATCH /staff/:id', () => {
        it('changes a name and a role, and records the change by field', async () => {
            const { agent, csrf } = await asAdmin();

            const response = await agent
                .patch(`/api/v1/staff/${staffId('ravi@example.com')}`)
                .set('X-CSRF-Token', csrf)
                .send({ name: 'Ravi K. Kumar', role: 'SALES_MANAGER' })
                .expect(200);

            expect(response.body.staff).toMatchObject({
                name: 'Ravi K. Kumar',
                role: 'SALES_MANAGER',
                status: 'ACTIVE',
            });
            const line = admin.byAction(AuditAction.StaffUpdated).at(-1)!;
            expect(line.detail).toEqual({
                fields: ['name', 'role'],
                role: { from: 'CLOSER', to: 'SALES_MANAGER' },
            });
            expect(JSON.stringify(line.detail)).not.toContain('Ravi');
        });

        it('needs the CSRF header', async () => {
            const { agent } = await asAdmin();

            const response = await agent
                .patch(`/api/v1/staff/${staffId('ravi@example.com')}`)
                .send({ name: 'No Header' })
                .expect(403);

            expect(response.body.code).toBe('CSRF_INVALID');
        });

        it('rejects an empty body, a bad role and an unknown field value', async () => {
            const { agent, csrf } = await asAdmin();
            const patch = (body: object) =>
                agent
                    .patch(`/api/v1/staff/${staffId('ravi@example.com')}`)
                    .set('X-CSRF-Token', csrf)
                    .send(body);

            const empty = await patch({}).expect(400);
            expect(empty.body.code).toBe('VALIDATION_FAILED');
            expect(empty.body.message).toBe('Send a name, a role or both');

            const role = await patch({ role: 'KING' }).expect(400);
            expect(role.body.fields.role).toBeTruthy();
        });

        it('lets an admin rename themselves but not change their own role', async () => {
            const { agent, csrf } = await asAdmin();
            const self = `/api/v1/staff/${staffId(ADMIN.email)}`;

            await agent
                .patch(self)
                .set('X-CSRF-Token', csrf)
                .send({ name: 'Admin' })
                .expect(200);
            const response = await agent
                .patch(self)
                .set('X-CSRF-Token', csrf)
                .send({ role: 'BDA' })
                .expect(409);

            expect(response.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');
        });

        it('answers 404 for an unknown id and 400 for a malformed one', async () => {
            const { agent, csrf } = await asAdmin();

            const missing = await agent
                .patch(`/api/v1/staff/${UUID_UNKNOWN}`)
                .set('X-CSRF-Token', csrf)
                .send({ name: 'Nobody' })
                .expect(404);
            expect(missing.body.code).toBe('STAFF_NOT_FOUND');
            await agent
                .patch('/api/v1/staff/not-a-uuid')
                .set('X-CSRF-Token', csrf)
                .send({ name: 'Nobody' })
                .expect(400);
        });

        it('is refused for a non-admin', async () => {
            const bda = await signIn(app, BDA.email, BDA.password);

            await bda.agent
                .patch(`/api/v1/staff/${staffId('ravi@example.com')}`)
                .set('X-CSRF-Token', bda.csrf)
                .send({ name: 'Hacker' })
                .expect(403);
        });
    });

    describe('deactivate and reactivate', () => {
        const MEERA = {
            email: 'meera@example.com',
            password: 'meera-password-123',
        };

        it('switches an account off at once: sign-in, refresh and /me all stop', async () => {
            const { agent, csrf } = await asAdmin();
            const victim = await signIn(app, MEERA.email, MEERA.password);
            expect(victim.response.status).toBe(200);

            const response = await agent
                .post(`/api/v1/staff/${staffId(MEERA.email)}/deactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(200);

            expect(response.body.staff.status).toBe('DEACTIVATED');
            await victim.agent.get('/api/v1/auth/me').expect(401);
            await victim.agent
                .post('/api/v1/auth/refresh')
                .set('X-CSRF-Token', victim.csrf)
                .expect(401);
            const login = await signIn(app, MEERA.email, MEERA.password);
            expect(login.response.status).toBe(401);
            expect(login.response.body.code).toBe('INVALID_CREDENTIALS');
            expect(
                admin.byAction(AuditAction.StaffDeactivated).at(-1),
            ).toMatchObject({
                entityId: staffId(MEERA.email),
            });
        });

        it('is safe to repeat, and shows up in the DEACTIVATED filter', async () => {
            const { agent, csrf } = await asAdmin();
            const before = admin.byAction(AuditAction.StaffDeactivated).length;

            await agent
                .post(`/api/v1/staff/${staffId(MEERA.email)}/deactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(200);

            expect(admin.byAction(AuditAction.StaffDeactivated)).toHaveLength(
                before,
            );
            const list = await agent
                .get('/api/v1/staff?status=DEACTIVATED')
                .expect(200);
            expect(list.body.staff.map((s: any) => s.name)).toEqual([
                'Meera Das',
            ]);
        });

        it('refuses to deactivate yourself', async () => {
            const { agent, csrf } = await asAdmin();

            const response = await agent
                .post(`/api/v1/staff/${staffId(ADMIN.email)}/deactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(409);

            expect(response.body.code).toBe('CANNOT_DEACTIVATE_SELF');
        });

        it('cuts off an admin whose access token is still valid', async () => {
            const first = await asAdmin();
            const second = await asAdmin(SECOND_ADMIN);
            await second.agent.get('/api/v1/staff').expect(200);

            await first.agent
                .post(`/api/v1/staff/${staffId(SECOND_ADMIN.email)}/deactivate`)
                .set('X-CSRF-Token', first.csrf)
                .expect(200);

            // Same cookies, token not expired: refused because the database says so.
            await second.agent.get('/api/v1/staff').expect(401);
            await first.agent
                .post(`/api/v1/staff/${staffId(SECOND_ADMIN.email)}/reactivate`)
                .set('X-CSRF-Token', first.csrf)
                .expect(200);
        });

        it('brings an account back pending, with a new emailed password and not the old one', async () => {
            const { agent, csrf } = await asAdmin();

            const response = await agent
                .post(`/api/v1/staff/${staffId(MEERA.email)}/reactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(200);

            expect(response.body.staff.status).toBe('PENDING');
            const emailed = queue.add.mock.calls[0][1].data.temporaryPassword;
            expect(JSON.stringify(response.body)).not.toContain(emailed);
            expect(
                (await signIn(app, MEERA.email, MEERA.password)).response
                    .status,
            ).toBe(401);
            const login = await signIn(app, MEERA.email, emailed);
            expect(login.response.status).toBe(200);
            expect(login.response.body.user.mustChangePassword).toBe(true);
            expect(
                admin.byAction(AuditAction.StaffReactivated).at(-1),
            ).toMatchObject({ entityId: staffId(MEERA.email) });
        });

        it('refuses to reactivate an active account, so its password is never replaced by accident', async () => {
            const { agent, csrf } = await asAdmin();

            const response = await agent
                .post(`/api/v1/staff/${staffId(BDA.email)}/reactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(409);

            expect(response.body.code).toBe('STAFF_ALREADY_ACTIVE');
            expect(queue.add).not.toHaveBeenCalled();
        });

        it('leaves the account deactivated if the email cannot be queued', async () => {
            const { agent, csrf } = await asAdmin();
            await agent
                .post(`/api/v1/staff/${staffId(MEERA.email)}/deactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(200);
            queue.ready = new Promise(() => undefined);

            const response = await agent
                .post(`/api/v1/staff/${staffId(MEERA.email)}/reactivate`)
                .set('X-CSRF-Token', csrf)
                .expect(503);

            expect(response.body.code).toBe('EMAIL_QUEUE_UNAVAILABLE');
            expect(repository.accountByEmail(MEERA.email)!.isActive).toBe(
                false,
            );
        });
    });

    describe('audit trail of staff changes', () => {
        it('holds ids and field names only: no emails, names or passwords', async () => {
            const lines = JSON.stringify(admin.audits, (_k, v) =>
                typeof v === 'bigint' ? v.toString() : v,
            );

            expect(admin.audits.length).toBeGreaterThan(0);
            for (const email of [
                'ravi@example.com',
                'meera@example.com',
                ADMIN.email,
            ]) {
                expect(lines).not.toContain(email);
            }
            for (const secret of [
                ADMIN.password,
                'Ravi K. Kumar',
                'Meera Das',
            ]) {
                expect(lines).not.toContain(secret);
            }
            for (const call of queue.add.mock.calls) {
                expect(lines).not.toContain(call[1].data.temporaryPassword);
            }
        });
    });
});
