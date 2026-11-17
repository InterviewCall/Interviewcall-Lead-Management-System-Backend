/**
 * The bell (in-app alerts) against a REAL MySQL/MariaDB database: alerts for a new assignment, a call starting soon and an
 * overdue follow-up, reading and clearing them, and that nobody sees anyone else's. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- notifications
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

/** The same outcomes the seed makes. */
const OUTCOMES = [
    { name: 'Connected', effect: { connected: true, lifecycle: 'ENGAGED_LEAD' }, requiresFollowup: true },
    { name: 'Interested', effect: { connected: true, lifecycle: 'PROSPECT' }, requiresFollowup: true },
    { name: 'Call back later', effect: { connected: true, conversation: false }, requiresFollowup: true },
    { name: 'No answer', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
    { name: 'Busy', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
    { name: 'Switched off', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
    { name: 'Wrong number', effect: { connected: false, closeAs: 'LOST', lostReason: 'Wrong Number' }, requiresFollowup: false },
    { name: 'Not interested', effect: { connected: true, lifecycle: 'NOT_INTERESTED' }, requiresFollowup: false },
];

describe.skipIf(!enabled)('notifications (real database)', () => {
    let app: INestApplication;
    let db: ModelService;
    const users: Record<string, { id: bigint; publicId: string; email: string }> = {};
    const outcome: Record<string, number> = {};

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
        await make('closer', 'Closer Chen', 'CLOSER');
        await make('ops', 'Ops Omar', 'OPS');
        await db.leadSource.create({ data: { name: 'WorkR', group: 'WORKR' } });
        for (const name of ['Wrong Number', 'Out of TG', 'Disqualified']) await db.lostReason.create({ data: { name } });
        for (const [index, o] of OUTCOMES.entries()) {
            const row = await db.outcome.create({ data: { ...o, sortOrder: index } });
            outcome[o.name] = row.id;
        }
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
            'lead_list_members', 'lead_lists', 'lead_score_entries', 'lead_events', 'lead_assignments', 'opportunity_stage_changes',
            'opportunities', 'touchpoints', 'activities', 'tasks', 'notifications', 'bookings', 'form_responses', 'lead_identities', 'leads',
        ];
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
    }

    beforeEach(clearLeadData);

    const session = (key: string) => signIn(app, users[key].email, PASSWORD);

    /** A lead owned by `owner` with an open opportunity at Call 1 Pending. */
    async function makeLead(n: number, over: { owner?: string | null; lifecycle?: 'MARKETING_LEAD' | 'ENROLLED'; opportunity?: boolean } = {}) {
        const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        const ownerId = over.owner === null ? null : users[over.owner ?? 'bda1'].id;
        const lead = await db.lead.create({
            data: {
                fullName: `Person ${n}`, email: `p${n}@example.com`, phoneLast10: mobile(n), phoneE164: `+91${mobile(n)}`,
                ownerId, firstSourceId: source.id, capturedAt: new Date(), lifecycleStage: over.lifecycle ?? 'MARKETING_LEAD',
                identities: { create: [{ type: 'EMAIL', value: `p${n}@example.com` }, { type: 'PHONE', value: mobile(n) }] },
            },
        });
        if (over.opportunity !== false && over.lifecycle !== 'ENROLLED') {
            await db.opportunity.create({ data: { leadId: lead.id, openLeadId: lead.id, stage: 'CALL_1_PENDING', ownerId } });
        }
        return lead;
    }

    const bell = async (key: string) => {
        const s = await session(key);
        const res = await s.agent.get('/api/v1/notifications');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as { unread: number; items: Array<{ id: string; type: string; message: string; read: boolean; createdAt: string; lead: { id: string; name: string } | null }> };
    };
    const assign = async (leads: Array<{ publicId: string }>, toKey: string, byKey = 'manager') => {
        const m = await session(byKey);
        const res = await m.agent.post('/api/v1/assignment/bulk').set('X-CSRF-Token', m.csrf).send({ leadIds: leads.map((l) => l.publicId), toUserId: users[toKey].publicId });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    const task = (leadId: bigint, assignee: string, dueAt: Date, over: Record<string, unknown> = {}) =>
        db.task.create({ data: { leadId, assigneeId: users[assignee].id, type: 'FOLLOW_UP', title: 'Call back', dueAt, ...over } });
    const minutes = (m: number) => new Date(Date.now() + m * 60_000);

    describe('a new assignment', () => {
        it('tells the new owner, naming the lead when there is one and counting when there are several', async () => {
            const one = await makeLead(1, { owner: null });
            await assign([one], 'bda1');
            const first = await bell('bda1');
            expect(first.unread).toBe(1);
            expect(first.items[0]).toMatchObject({ type: 'NEW_ASSIGNMENT', message: 'A new lead was assigned to you', read: false, lead: { id: one.publicId, name: 'Person 1' } });

            const more = [await makeLead(2, { owner: null }), await makeLead(3, { owner: null }), await makeLead(4, { owner: null })];
            await assign(more, 'bda1');
            const second = await bell('bda1');
            expect(second.unread).toBe(2);
            expect(second.items[0]).toMatchObject({ message: '3 new leads were assigned to you', lead: null });
        });

        it('says nothing to someone who gives the leads to themselves, and nothing to the people who were not given any', async () => {
            const lead = await makeLead(1, { owner: null });
            await assign([lead], 'manager', 'manager');
            expect((await bell('manager')).items).toEqual([]);
            for (const key of ['bda1', 'bda2', 'closer', 'ops', 'admin']) expect((await bell(key)).items).toEqual([]);
        });

        it('does not alert when the lead already belongs to that person', async () => {
            const lead = await makeLead(1);
            await assign([lead], 'bda1');
            expect((await bell('bda1')).items).toEqual([]);
        });
    });

    describe('a call starting soon', () => {
        it('alerts the owner once, within 30 minutes of the slot, and not before or for someone else', async () => {
            const lead = await makeLead(1);
            const far = await makeLead(2);
            const theirs = await makeLead(3, { owner: 'bda2' });
            await task(lead.id, 'bda1', minutes(12), { type: 'SCHEDULED_CALL', title: 'Counselling call', bookingRef: 'b1' });
            await task(far.id, 'bda1', minutes(180), { type: 'SCHEDULED_CALL', title: 'Counselling call', bookingRef: 'b2' });
            await task(theirs.id, 'bda2', minutes(10), { type: 'SCHEDULED_CALL', title: 'Counselling call', bookingRef: 'b3' });

            const first = await bell('bda1');
            expect(first.items).toHaveLength(1);
            expect(first.items[0]).toMatchObject({ type: 'SLOT_SOON', lead: { id: lead.publicId, name: 'Person 1' } });
            expect(first.items[0].message).toMatch(/^A booked call starts at \d{1,2}:\d{2} (am|pm)$/i);
            expect((await bell('bda1')).items).toHaveLength(1); // asking again does not repeat it
            expect((await bell('bda2')).items.map((i) => i.lead?.name)).toEqual(['Person 3']);
        });

        it('leaves out a call that is already done', async () => {
            const lead = await makeLead(1);
            await task(lead.id, 'bda1', minutes(5), { type: 'SCHEDULED_CALL', title: 'x', bookingRef: 'b1', status: 'DONE' });
            expect((await bell('bda1')).items).toEqual([]);
        });
    });

    describe('an overdue follow-up', () => {
        it('alerts once when a follow-up goes overdue, not for a future, finished, cancelled or very old one', async () => {
            const a = await makeLead(1);
            const b = await makeLead(2);
            const c = await makeLead(3);
            const d = await makeLead(4);
            await task(a.id, 'bda1', minutes(-45), { title: 'Overdue' });
            await task(b.id, 'bda1', minutes(60), { title: 'Later' });
            await task(c.id, 'bda1', minutes(-45), { title: 'Done', status: 'DONE' });
            await task(c.id, 'bda1', minutes(-50), { title: 'Cancelled', status: 'CANCELLED' });
            await task(d.id, 'bda1', minutes(-60 * 30), { title: 'Weeks ago' });

            const first = await bell('bda1');
            expect(first.items).toHaveLength(1);
            expect(first.items[0]).toMatchObject({ type: 'FOLLOWUP_OVERDUE', message: 'A follow-up is overdue', lead: { name: 'Person 1' } });
            expect((await bell('bda1')).items).toHaveLength(1);
        });

        it('keeps the message free of anything typed into the task', async () => {
            const lead = await makeLead(1);
            await task(lead.id, 'bda1', minutes(-10), { title: 'Call about the loan, 98765 43210' });
            const res = await bell('bda1');
            expect(JSON.stringify(res.items[0].message)).not.toMatch(/loan|98765/);
        });
    });

    describe('reading and clearing', () => {
        async function twoAlerts() {
            await assign([await makeLead(1, { owner: null })], 'bda1');
            await assign([await makeLead(2, { owner: null })], 'bda1');
            await assign([await makeLead(3, { owner: null })], 'bda2');
        }

        it('marks one alert read, the newest first, and the unread count drops', async () => {
            await twoAlerts();
            const s = await session('bda1');
            const before = await bell('bda1');
            expect(before.items.map((i) => i.lead?.name)).toEqual(['Person 2', 'Person 1']);
            const res = await s.agent.post(`/api/v1/notifications/${before.items[0].id}/read`).set('X-CSRF-Token', s.csrf);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const after = await bell('bda1');
            expect(after.unread).toBe(1);
            expect(after.items.map((i) => i.read)).toEqual([true, false]);
        });

        it('marks everything read at once', async () => {
            await twoAlerts();
            const s = await session('bda1');
            expect((await s.agent.post('/api/v1/notifications/read-all').set('X-CSRF-Token', s.csrf)).status).toBe(200);
            const after = await bell('bda1');
            expect(after.unread).toBe(0);
            expect(after.items.every((i) => i.read)).toBe(true);
        });

        it('never shows or clears someone else’s alerts', async () => {
            await twoAlerts();
            const theirs = (await bell('bda2')).items[0];
            const s = await session('bda1');
            expect((await bell('bda1')).items.map((i) => i.id)).not.toContain(theirs.id);
            const res = await s.agent.post(`/api/v1/notifications/${theirs.id}/read`).set('X-CSRF-Token', s.csrf);
            expect(res.status).toBe(200); // no hint whether it exists
            expect((await bell('bda2')).unread).toBe(1);
            await s.agent.post('/api/v1/notifications/read-all').set('X-CSRF-Token', s.csrf);
            expect((await bell('bda2')).unread).toBe(1);
        });

        it('rejects a bad id', async () => {
            const s = await session('bda1');
            expect((await s.agent.post('/api/v1/notifications/abc/read').set('X-CSRF-Token', s.csrf)).status).toBe(400);
        });
    });

    describe('who may open it', () => {
        it('every role has a bell, and a signed-out visitor gets nothing', async () => {
            for (const key of ['admin', 'manager', 'ops', 'bda1', 'closer']) expect((await bell(key)).unread).toBe(0);
            const anon = await (await import('supertest')).default(app.getHttpServer()).get('/api/v1/notifications');
            expect(anon.status).toBe(401);
        });
    });
});
