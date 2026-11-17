/**
 * Bulk actions on the leads list (changing the contact stage and adding a follow-up to many leads at once), against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- bulk-actions
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
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('Bulk actions on leads (real database)', () => {
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

    const post = async (key: string, path: string, body: unknown) => {
        const s = await session(key);
        return s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body as object);
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

    const stageOf = async (id: bigint) => (await db.lead.findUniqueOrThrow({ where: { id } })).lifecycleStage;
    const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

    describe('changing the contact stage of many leads', () => {
        it('changes each lead with the same rules as one lead, writes each timeline, and counts what was already there', async () => {
            const a = await makeLead(1, { owner: 'bda1' });
            const b = await makeLead(2, { owner: 'bda2' });
            const c = await makeLead(3, { owner: 'bda1', lifecycle: 'NOT_INTERESTED' });
            await db.lead.update({ where: { id: b.id }, data: { lifecycleStage: 'PROSPECT' } });

            const res = await post('manager', '/leads/contact-stage/bulk', { leadIds: [a.publicId, b.publicId, c.publicId], stage: 'PROSPECT' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual({ done: 2, unchanged: 1, skipped: [] });
            expect(await stageOf(a.id)).toBe('PROSPECT');
            expect(await stageOf(c.id)).toBe('PROSPECT');
            const events = await db.leadEvent.findMany({ where: { type: 'CONTACT_STAGE_CHANGED' } });
            expect(events).toHaveLength(2);
            expect(events.every((e) => e.actorId === users.manager.id)).toBe(true);
        });

        it('skips the leads the rules refuse and says why, and changes the rest', async () => {
            const open = await makeLead(4, { owner: 'bda1' });
            const enrolled = await makeLead(5, { owner: 'bda1', lifecycle: 'ENROLLED' });
            const others = await makeLead(6, { owner: 'bda2' });
            const res = await post('bda1', '/leads/contact-stage/bulk', { leadIds: [open.publicId, enrolled.publicId, others.publicId], stage: 'NOT_INTERESTED' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.done).toBe(1);
            expect(res.body.skipped).toEqual(
                expect.arrayContaining([
                    { reason: 'Only an admin or sales manager can move an enrolled lead back', count: 1 },
                    { reason: 'This lead does not exist or you cannot open it', count: 1 },
                ]),
            );
            expect(await stageOf(open.id)).toBe('NOT_INTERESTED');
            expect(await stageOf(enrolled.id)).toBe('ENROLLED');
            expect(await stageOf(others.id)).toBe('MARKETING_LEAD');
        });

        it('onboards only enrolled leads', async () => {
            const enrolled = await makeLead(7, { lifecycle: 'ENROLLED' });
            const open = await makeLead(8);
            const res = await post('ops', '/leads/contact-stage/bulk', { leadIds: [enrolled.publicId, open.publicId], stage: 'LEARNER_ONBOARDED' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual({ done: 1, unchanged: 0, skipped: [{ reason: 'Only an Enrolled lead can be marked Learner Onboarded', count: 1 }] });
        });

        it('refuses the whole request when the role or the stage rules it out, or the choice is empty or too big', async () => {
            const lead = await makeLead(9);
            expect((await post('ops', '/leads/contact-stage/bulk', { leadIds: [lead.publicId], stage: 'PROSPECT' })).status).toBe(403);
            const enrol = await post('manager', '/leads/contact-stage/bulk', { leadIds: [lead.publicId], stage: 'ENROLLED' });
            expect(enrol.status).toBe(409);
            expect(enrol.body.code).toBe('ENROLL_VIA_CLOSED_WON');
            expect((await post('manager', '/leads/contact-stage/bulk', { leadIds: [], stage: 'PROSPECT' })).status).toBe(400);
            const many = Array.from({ length: 501 }, () => lead.publicId);
            expect((await post('manager', '/leads/contact-stage/bulk', { leadIds: many, stage: 'PROSPECT' })).status).toBe(400);
            expect(await stageOf(lead.id)).toBe('MARKETING_LEAD');
        });
    });

    describe('adding a follow-up to many leads', () => {
        it('gives each lead the task, assigned to its owner (or to the person adding it when it has none), and sets its next follow-up', async () => {
            const owned = await makeLead(10, { owner: 'bda1' });
            const unowned = await makeLead(11);
            const dueAt = inAnHour();
            const res = await post('manager', '/leads/tasks/bulk', { leadIds: [owned.publicId, unowned.publicId, owned.publicId], title: 'Share the batch schedule', dueAt });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual({ done: 2, unchanged: 0, skipped: [] });
            const tasks = await db.task.findMany({ orderBy: { leadId: 'asc' } });
            expect(tasks.map((t) => [t.leadId, t.assigneeId, t.title, t.type, t.status, t.createdById])).toEqual([
                [owned.id, users.bda1.id, 'Share the batch schedule', 'FOLLOW_UP', 'OPEN', users.manager.id],
                [unowned.id, users.manager.id, 'Share the batch schedule', 'FOLLOW_UP', 'OPEN', users.manager.id],
            ]);
            const leads = await db.lead.findMany({ where: { id: { in: [owned.id, unowned.id] } } });
            expect(leads.every((l) => l.nextFollowupAt?.toISOString() === new Date(dueAt).toISOString())).toBe(true);
            expect(await db.leadEvent.count({ where: { type: 'TASK_CREATED' } })).toBe(2);
        });

        it('skips leads a BDA cannot open, and refuses a past time, a missing title and roles that cannot add tasks', async () => {
            const mine = await makeLead(12, { owner: 'bda1' });
            const theirs = await makeLead(13, { owner: 'bda2' });
            const res = await post('bda1', '/leads/tasks/bulk', { leadIds: [mine.publicId, theirs.publicId], title: 'Call back', dueAt: inAnHour() });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual({ done: 1, unchanged: 0, skipped: [{ reason: 'This lead does not exist or you cannot open it', count: 1 }] });
            expect(await db.task.count({ where: { leadId: theirs.id } })).toBe(0);

            const past = await post('manager', '/leads/tasks/bulk', { leadIds: [mine.publicId], title: 'Call back', dueAt: new Date(Date.now() - 86_400_000).toISOString() });
            expect(past.status).toBe(400);
            expect(past.body.fields).toMatchObject({ dueAt: 'Choose a time that has not passed' });
            expect((await post('manager', '/leads/tasks/bulk', { leadIds: [mine.publicId], title: ' ', dueAt: inAnHour() })).status).toBe(400);
            expect((await post('ops', '/leads/tasks/bulk', { leadIds: [mine.publicId], title: 'Call back', dueAt: inAnHour() })).status).toBe(403);
            expect(await db.task.count()).toBe(1);
        });
    });
});
