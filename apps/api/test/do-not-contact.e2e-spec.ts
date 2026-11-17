/**
 * Do-not-contact and the suppression check, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- do-not-contact
 */
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ModelService } from '@app/model';
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from '@app/rate-limit';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { IMPORTS_QUEUE } from '../src/modules/imports/imports.constants.js';
import { INTAKE_QUEUE } from '../src/modules/intake/intake.constants.js';
import { NOTIFICATIONS_QUEUE } from '../src/notifications/notifications.constants.js';
import request from 'supertest';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('Do not contact, suppression and batch intake (real database)', () => {
    let app: INestApplication;
    let db: ModelService;
    const users: Record<string, { id: bigint; publicId: string; email: string }> = {};

    let clock = Date.now();
    beforeEach(() => {
        clock += 120_000;
    });

    beforeAll(async () => {
        process.env.DB_HOST = env.CRM_TEST_DB_HOST;
        process.env.DB_PORT = env.CRM_TEST_DB_PORT ?? '3306';
        process.env.DB_USER = env.CRM_TEST_DB_USER;
        process.env.DB_PASSWORD = env.CRM_TEST_DB_PASSWORD ?? '';
        process.env.DB_NAME = env.CRM_TEST_DB_NAME;
        process.env.CRM_WEB_ORIGIN = 'http://localhost:3002';

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(RATE_LIMIT_STORE)
            .useValue(new InMemoryRateLimitStore(() => clock))
            .overrideProvider(getQueueToken(NOTIFICATIONS_QUEUE))
            .useValue({ waitUntilReady: () => Promise.resolve(), add: vi.fn(), close: vi.fn() })
            .overrideProvider(getQueueToken(IMPORTS_QUEUE))
            .useValue({ waitUntilReady: () => Promise.resolve(), add: vi.fn(), close: vi.fn() })
            .overrideProvider(getQueueToken(INTAKE_QUEUE))
            .useValue({ waitUntilReady: () => Promise.resolve(), add: vi.fn(), close: vi.fn() })
            .compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(ModelService);

        await wipe();
        const hash = await cheapHash(PASSWORD);
        const make = async (key: string, name: string, role: 'ADMIN' | 'SALES_MANAGER' | 'BDA' | 'CLOSER' | 'OPS') => {
            const email = `${key}@example.com`;
            const user = await db.staffUser.create({
                data: { name, email, passwordHash: hash, role, mustChangePassword: false },
                select: { id: true, publicId: true },
            });
            users[key] = { ...user, email };
        };
        await make('admin', 'Admin Anu', 'ADMIN');
        await make('manager', 'Manager Mira', 'SALES_MANAGER');
        await make('bda1', 'BDA Bose', 'BDA');
        await make('bda2', 'BDA Rao', 'BDA');
        await make('bda3', 'BDA Sen', 'BDA');
        await make('closer', 'Closer Chen', 'CLOSER');
        await make('ops', 'Ops Omar', 'OPS');
        await db.leadSource.create({ data: { name: 'WorkR', group: 'WORKR' } });
        await db.leadSource.create({ data: { name: 'Organic', group: 'ORGANIC' } });
        await db.leadSource.create({ data: { name: 'Old source', group: 'META', isActive: false } });
    }, 60_000);

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app?.close();
    });

    async function wipe() {
        const tables = await db.$queryRawUnsafe<{ TABLE_NAME: string }[]>(
            `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> '_prisma_migrations'`,
        );
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const { TABLE_NAME } of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
    }

    async function clearLeadData() {
        const tables = [
            'lead_list_members', 'lead_lists', 'lead_score_entries', 'lead_events', 'lead_assignments', 'distribution_cursors', 'notifications', 'opportunity_stage_changes',
            'opportunities', 'touchpoints', 'activities', 'tasks', 'bookings', 'form_responses', 'lead_identities', 'leads',
        ];
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
        await db.staffUser.updateMany({ data: { leaveUntil: null, isActive: true } });
    }

    beforeEach(clearLeadData);

    const session = (key: string) => signIn(app, users[key].email, PASSWORD);

    const send = async (key: string, method: 'post' | 'patch', path: string, body: unknown) => {
        const sess = await session(key);
        return sess.agent[method](`/api/v1${path}`).set('X-CSRF-Token', sess.csrf).send(body as object);
    };

    async function makeLead(n: number, over: { owner?: string | null; lifecycle?: 'MARKETING_LEAD' | 'ENROLLED' | 'NOT_INTERESTED'; email?: string | null } = {}) {
        const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        const email = over.email === undefined ? `p${n}@example.com` : over.email;
        const lead = await db.lead.create({
            data: {
                fullName: `Person ${n}`, email, phoneLast10: mobile(n), phoneE164: `+91${mobile(n)}`,
                ownerId: over.owner ? users[over.owner].id : null,
                firstSourceId: source.id, capturedAt: new Date(), lifecycleStage: over.lifecycle ?? 'MARKETING_LEAD',
                identities: { create: [...(email ? [{ type: 'EMAIL' as const, value: email }] : []), { type: 'PHONE' as const, value: mobile(n) }] },
            },
        });
        if (over.lifecycle !== 'ENROLLED') {
            await db.opportunity.create({ data: { leadId: lead.id, openLeadId: lead.id, stage: 'CALL_1', status: 'OPEN', ownerId: lead.ownerId, stageChangedAt: new Date() } });
        }
        return lead;
    }




    const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

    it('lets the owner mark a lead, cancels its follow-ups and refuses new ones', async () => {
        const lead = await makeLead(1, { owner: 'bda1' });
        expect((await send('bda1', 'post', `/leads/${lead.publicId}/tasks`, { title: 'Call back', dueAt: inHours(2) })).status).toBe(200);
        const res = await send('bda1', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: true, reason: 'Asked on WhatsApp to stop' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact).toBe(true);
        expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowupAt).toBeNull();
        expect((await db.task.findMany({ where: { leadId: lead.id } })).every((t) => t.status === 'CANCELLED')).toBe(true);
        expect(await db.leadEvent.count({ where: { leadId: lead.id, type: 'DO_NOT_CONTACT_SET' } })).toBe(1);
        expect(await db.auditLog.count({ where: { action: 'lead.dnc_set', entityId: lead.publicId } })).toBe(1);

        const again = await send('bda1', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: true });
        expect(again.status).toBe(200);
        expect(await db.leadEvent.count({ where: { leadId: lead.id, type: 'DO_NOT_CONTACT_SET' } })).toBe(1);

        const refused = await send('bda1', 'post', `/leads/${lead.publicId}/tasks`, { title: 'Again', dueAt: inHours(2) });
        expect(refused.status).toBe(409);
        expect(refused.body.code ?? refused.body.error?.code).toBe('DO_NOT_CONTACT');
        const bulk = await send('manager', 'post', '/leads/tasks/bulk', { leadIds: [lead.publicId], title: 'Bulk', dueAt: inHours(3) });
        expect(bulk.status).toBe(200);
        expect(bulk.body.done).toBe(0);
        expect(bulk.body.skipped?.length ?? bulk.body.skipped).toBeTruthy();
    });

    it('only lets a manager or admin allow contact again, and others cannot touch leads they cannot see', async () => {
        const lead = await makeLead(2, { owner: 'bda1' });
        await send('bda1', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: true });
        expect((await send('bda1', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: false })).status).toBe(403);
        expect((await send('bda2', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: false })).status).toBe(404);
        expect((await send('ops', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: false })).status).toBe(403);
        expect((await send('manager', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: false })).status).toBe(200);
        expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact).toBe(false);
        expect(await db.leadEvent.count({ where: { leadId: lead.id, type: 'DO_NOT_CONTACT_CLEARED' } })).toBe(1);
        expect((await send('bda1', 'post', `/leads/${lead.publicId}/tasks`, { title: 'OK now', dueAt: inHours(2) })).status).toBe(200);
        expect((await send('bda1', 'post', `/leads/${lead.publicId}/do-not-contact`, {})).status).toBe(400);
    });

    it('answers which phones and emails are suppressed, for staff and for a source key', async () => {
        const a = await makeLead(3, { owner: 'bda1', email: 'Stop.Me@Example.com' });
        await makeLead(4, { owner: 'bda1' });
        await db.lead.update({ where: { id: a.id }, data: { doNotContact: true } });
        const body = { phones: [`+91 ${mobile(3)}`, mobile(4), 'abc'], emails: ['stop.me@example.com', 'p4@example.com'] };
        const staff = await send('bda1', 'post', '/leads/suppression/check', body);
        expect(staff.status, JSON.stringify(staff.body)).toBe(200);
        expect(staff.body).toEqual({ suppressedPhones: [`+91 ${mobile(3)}`], suppressedEmails: ['stop.me@example.com'], invalidPhones: ['abc'] });
        expect((await send('bda1', 'post', '/leads/suppression/check', { phones: [], emails: [] })).status).toBe(400);

        const admin = await session('admin');
        const k = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'Gateway', system: 'WORKR' });
        const key = k.body.key as string;
        const viaKey = await request(app.getHttpServer()).post('/api/v1/intake/suppression/check').set('x-intake-key', key).send(body);
        expect(viaKey.status, JSON.stringify(viaKey.body)).toBe(200);
        expect(viaKey.body.suppressedPhones).toEqual([`+91 ${mobile(3)}`]);
        expect((await request(app.getHttpServer()).post('/api/v1/intake/suppression/check').send(body)).status).toBe(401);
    });

    it('takes a batch of intake events and answers for every row', async () => {
        const admin = await session('admin');
        const k = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'WorkR batch', system: 'WORKR' });
        const key = k.body.key as string;
        const post = (body: unknown, header: string | null = key) => {
            const r = request(app.getHttpServer()).post('/api/v1/intake/events/batch');
            return (header ? r.set('x-intake-key', header) : r).send(body as object);
        };
        const ev = (n: number, over: Record<string, unknown> = {}) => ({
            eventId: `batch-${n}`,
            type: 'workr.signup',
            occurredAt: new Date().toISOString(),
            payload: { userId: n, fullName: `Batch ${n}`, email: `batch${n}@example.com`, phoneNo: mobile(n + 50), details: 'Working Professional' },
            ...over,
        });
        const res = await post({ events: [ev(1), ev(2), ev(1), { eventId: 'bad-1' }, ev(3, { type: 'vsl.slot_booked' }), ev(4, { payload: { userId: 4 } })] });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ accepted: 2, duplicate: 1, rejected: 3 });
        expect(res.body.results.map((r: { index: number; status: string }) => [r.index, r.status])).toEqual([
            [0, 'accepted'], [1, 'accepted'], [2, 'duplicate'], [3, 'rejected'], [4, 'rejected'], [5, 'rejected'],
        ]);
        expect(res.body.results[3]).toMatchObject({ eventId: 'bad-1', code: 'ENVELOPE_INVALID' });
        expect(res.body.results[4].code).toBe('EVENT_TYPE_NOT_ALLOWED');
        expect(res.body.results[5].code).toBe('PAYLOAD_INVALID');
        expect(await db.inboxEvent.count()).toBe(2);

        expect((await post({ events: [] })).status).toBe(400);
        expect((await post({ events: Array.from({ length: 101 }, (_, i) => ev(i + 10)) })).status).toBe(400);
        expect((await post({ nope: 1 })).status).toBe(400);
        expect((await post({ events: [ev(9)] }, null)).status).toBe(401);
    });
});
