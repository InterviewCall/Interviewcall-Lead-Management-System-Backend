/**
 * The My day screen against a REAL MySQL/MariaDB database: what a person owes today, the booked calls, the week's
 * calls, the connect rate and the new leads, for a BDA (their own) and for a manager (the team's). Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- my-day
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
import { addDays, startOfIstDay } from '../src/modules/my-day/ist.js';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

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

describe.skipIf(!enabled)('My day (real database)', () => {
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
            'opportunities', 'touchpoints', 'activities', 'tasks', 'bookings', 'form_responses', 'lead_identities', 'leads',
        ];
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
    }

    beforeEach(clearLeadData);

    const session = (key: string) => signIn(app, users[key].email, PASSWORD);
    type Session = Awaited<ReturnType<typeof session>>;

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

    const log = (s: Session, lead: { publicId: string }, body: Record<string, unknown>) =>
        s.agent.post(`/api/v1/leads/${lead.publicId}/activities`).set('X-CSRF-Token', s.csrf).send(body);
    const call = (s: Session, lead: { publicId: string }, name: string, extra: Record<string, unknown> = {}) =>
        log(s, lead, { kind: 'CALL', outcomeId: outcome[name], nextStep: { title: 'Call again', dueAt: hoursFromNow(24) }, ...extra });

    const get = async (key: string) => {
        const s = await session(key);
        const res = await s.agent.get('/api/v1/my-day');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body;
    };
    const task = (leadId: bigint, assignee: string | null, dueAt: Date, over: Record<string, unknown> = {}) =>
        db.task.create({ data: { leadId, assigneeId: assignee ? users[assignee].id : null, type: 'FOLLOW_UP', title: 'Call back', dueAt, ...over } });
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    const todayStart = () => startOfIstDay(new Date());
    const activity = (leadId: bigint, userKey: string, at: Date, connected: boolean) =>
        db.activity.create({ data: { leadId, userId: users[userKey].id, kind: 'CALL', connected, occurredAt: at } });

    describe('follow-ups', () => {
        it('lists my open tasks due by the end of today, overdue first, and leaves out tomorrow and other people', async () => {
            const a = await makeLead(1);
            const b = await makeLead(2);
            const c = await makeLead(3);
            const other = await makeLead(4, { owner: 'bda2' });
            await db.lead.update({ where: { id: b.id }, data: { priorityRank: 50 } });
            const endOfToday = addDays(todayStart(), 1);
            await task(a.id, 'bda1', new Date(endOfToday.getTime() - 60_000), { title: 'Later today' });
            await task(b.id, 'bda1', hours(-5), { title: 'Overdue and hot' });
            await task(c.id, 'bda1', hours(-6), { title: 'Overdue and plain' });
            await task(c.id, 'bda1', new Date(endOfToday.getTime() + 3_600_000), { title: 'Tomorrow' });
            await task(other.id, 'bda2', hours(-1), { title: 'Not mine' });
            await task(a.id, 'bda1', hours(-2), { title: 'Done already', status: 'DONE' });
            await task(a.id, 'bda1', hours(-2), { title: 'Cancelled', status: 'CANCELLED' });

            const day = await get('bda1');
            expect(day.scope).toBe('mine');
            expect(day.followUps.map((f: { title: string }) => f.title)).toEqual(['Overdue and hot', 'Overdue and plain', 'Later today']);
            expect(day.followUps[0]).toMatchObject({ name: 'Person 2', leadId: b.publicId, overdue: true, kind: 'call', type: 'FOLLOW_UP' });
            expect(day.followUps[2].overdue).toBe(false);
            expect(day.kpis).toMatchObject({ due: 3, overdue: 2, unassigned: null });
            expect(JSON.stringify(day)).not.toMatch(/"id":"?\d+n/);
        });

        it('lets a manager open everyone\'s follow-ups with owners, and keeps a BDA on their own', async () => {
            const a = await makeLead(1);
            const b = await makeLead(2, { owner: 'bda2' });
            await task(a.id, 'manager', hours(-3), { title: 'Mine' });
            await task(b.id, 'bda2', hours(-2), { title: 'Theirs' });

            const mgr = await session('manager');
            const own = await mgr.agent.get('/api/v1/my-day');
            expect(own.body.view).toBe('mine');
            expect(own.body.followUps.map((f: { title: string }) => f.title)).toEqual(['Mine']);

            const team = await mgr.agent.get('/api/v1/my-day?view=team');
            expect(team.status).toBe(200);
            expect(team.body.view).toBe('team');
            expect(team.body.followUps.map((f: { title: string; mine: boolean }) => [f.title, f.mine]).sort()).toEqual([['Mine', true], ['Theirs', false]]);
            expect(team.body.followUps.find((f: { title: string }) => f.title === 'Theirs').owner).toBeTruthy();
            expect(team.body.kpis.due).toBe(2);

            const bda = await session('bda1');
            const sneak = await bda.agent.get('/api/v1/my-day?view=team');
            expect(sneak.body.view).toBe('mine');
            expect(sneak.body.followUps).toEqual([]);
        });

        it('shows a duplicate review as "other", and a scheduled call as a call', async () => {
            const lead = await makeLead(1);
            await task(lead.id, 'manager', hours(-1), { type: 'DUPLICATE_REVIEW', title: 'Possible duplicate' });
            await task(lead.id, 'manager', hours(-2), { type: 'SCHEDULED_CALL', title: 'Counselling call', bookingRef: 'bk-1' });
            const day = await get('manager');
            const byType = Object.fromEntries(day.followUps.map((f: { type: string }) => [f.type, f]));
            expect(byType['DUPLICATE_REVIEW'].kind).toBe('other');
            expect(byType['SCHEDULED_CALL'].kind).toBe('call');
        });

        it('a call logged with a next step replaces the answered follow-up on the list', async () => {
            const lead = await makeLead(1);
            await task(lead.id, 'bda1', hours(-3), { title: 'Old follow-up' });
            const s = await session('bda1');
            const res = await call(s, lead, 'Connected', { nextStep: { title: 'Send the test link', dueAt: hoursFromNow(0.5) } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const day = await get('bda1');
            const titles = day.followUps.map((f: { title: string }) => f.title);
            expect(titles).not.toContain('Old follow-up');
            expect(titles).toContain('Send the test link');
        });
    });

    describe('booked calls', () => {
        it('a BDA sees their own calls today; a manager sees the team with the unowned ones counted', async () => {
            const a = await makeLead(1);
            const b = await makeLead(2, { owner: null });
            const c = await makeLead(3, { owner: 'bda2' });
            const d = await makeLead(4);
            const noon = new Date(todayStart().getTime() + 6.5 * 3_600_000);
            await task(a.id, 'bda1', noon, { type: 'SCHEDULED_CALL', title: 'x', bookingRef: 'b1' });
            await task(b.id, null, new Date(noon.getTime() + 3_600_000), { type: 'SCHEDULED_CALL', title: 'x', bookingRef: 'b2' });
            await task(c.id, 'bda2', new Date(noon.getTime() + 7_200_000), { type: 'SCHEDULED_CALL', title: 'x', bookingRef: 'b3' });
            await task(d.id, 'bda1', addDays(noon, 1), { type: 'SCHEDULED_CALL', title: 'tomorrow', bookingRef: 'b4' });
            await task(d.id, 'bda1', noon, { type: 'SCHEDULED_CALL', title: 'done', bookingRef: 'b5', status: 'DONE' });

            const mine = await get('bda1');
            expect(mine.booked.map((x: { name: string }) => x.name)).toEqual(['Person 1']);
            expect(mine.booked[0]).toMatchObject({ owner: 'BDA Bose', mine: true });
            expect(mine.kpis.booked).toBe(1);
            expect(mine.kpis.unassigned).toBeNull();

            for (const key of ['manager', 'admin']) {
                const team = await get(key);
                expect(team.scope).toBe('team');
                expect(team.booked.map((x: { name: string }) => x.name)).toEqual(['Person 1', 'Person 2', 'Person 3']);
                expect(team.booked[1]).toMatchObject({ owner: null, mine: false });
                expect(team.booked[2]).toMatchObject({ owner: 'BDA Rao', mine: false });
                expect(team.kpis).toMatchObject({ booked: 3, unassigned: 1 });
            }
        });

        it('a manager taking an unowned call moves its task to them', async () => {
            const lead = await makeLead(1, { owner: null });
            await task(lead.id, null, new Date(todayStart().getTime() + 8 * 3_600_000), { type: 'SCHEDULED_CALL', title: 'x', bookingRef: 'b1' });
            const m = await session('manager');
            const res = await m.agent.post('/api/v1/assignment/bulk').set('X-CSRF-Token', m.csrf).send({ leadIds: [lead.publicId], toUserId: users.manager.publicId });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const day = await get('manager');
            expect(day.booked[0]).toMatchObject({ owner: 'Manager Mira', mine: true });
            expect(day.kpis.unassigned).toBe(0);
        });
    });

    describe('the week', () => {
        it('counts calls per day, answered and not, for me or for the team', async () => {
            const lead = await makeLead(1);
            const now = new Date();
            await activity(lead.id, 'bda1', now, true);
            await activity(lead.id, 'bda1', now, false);
            await activity(lead.id, 'bda2', now, false);
            await db.activity.create({ data: { leadId: lead.id, userId: users.bda1.id, kind: 'NOTE', occurredAt: now } });

            const mine = await get('bda1');
            const today = mine.week.find((d: { today: boolean }) => d.today);
            expect(today).toMatchObject({ total: 2, connected: 1 });
            expect(mine.week).toHaveLength(7);
            expect(mine.week.map((d: { day: string }) => d.day)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
            expect(mine.weekTotal).toBe(2);

            const team = await get('manager');
            expect(team.week.find((d: { today: boolean }) => d.today)).toMatchObject({ total: 3, connected: 1 });
            expect(team.weekTotal).toBe(3);
        });
    });

    describe('the connect rate', () => {
        it('is answered calls over all calls in the last 7 days, and the change from the 7 days before', async () => {
            const lead = await makeLead(1);
            const day = (n: number) => addDays(todayStart(), -n);
            const at = (n: number) => new Date(day(n).getTime() + 3_600_000);
            for (let i = 0; i < 4; i++) await activity(lead.id, 'bda1', at(2), i < 1); // this week: 1 of 4 = 25%
            for (let i = 0; i < 4; i++) await activity(lead.id, 'bda1', at(9), i < 2); // last week: 2 of 4 = 50%
            await activity(lead.id, 'bda1', at(20), true); // too old to count

            const res = await get('bda1');
            expect(res.kpis.connectRate).toBe(25);
            expect(res.kpis.connectRateChange).toBe(-25);
        });

        it('is empty, not 0%, when nobody has called', async () => {
            const res = await get('bda1');
            expect(res.kpis).toMatchObject({ connectRate: null, connectRateChange: null });
        });
    });

    describe('new leads', () => {
        it('the team sees leads that reached the CRM today against yesterday at the same time', async () => {
            const yesterdayStart = addDays(todayStart(), -1);
            await makeLead(1);
            await makeLead(2);
            const old = await makeLead(3);
            await db.lead.update({ where: { id: old.id }, data: { capturedAt: new Date(yesterdayStart.getTime() + 1) } });
            const res = await get('manager');
            expect(res.kpis.newLeads).toBe(2);
            expect(res.kpis.newLeadsChange).toBe(100);
        });

        it('a BDA sees leads given to them today, not the team total', async () => {
            const a = await makeLead(1);
            const b = await makeLead(2, { owner: 'bda2' });
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
            const base = { sourceId: source.id, vslDepth: 'NONE', method: 'BULK' } as const;
            await db.leadAssignment.create({ data: { ...base, leadId: a.id, toUserId: users.bda1.id } });
            await db.leadAssignment.create({ data: { ...base, leadId: a.id, toUserId: users.bda1.id } }); // handed twice, counted once
            await db.leadAssignment.create({ data: { ...base, leadId: b.id, toUserId: users.bda2.id } });
            const res = await get('bda1');
            expect(res.kpis.newLeads).toBe(1);
            expect(res.kpis.newLeadsChange).toBeNull();
        });
    });

    describe('who may open it', () => {
        it('every role gets its own page, and a signed-out visitor gets nothing', async () => {
            for (const key of ['admin', 'manager', 'ops', 'bda1', 'closer']) {
                const res = await get(key);
                expect(res.followUps).toEqual([]);
                expect(res.week).toHaveLength(7);
            }
            const ops = await get('ops');
            expect(ops.scope).toBe('team');
            expect((await get('closer')).scope).toBe('mine');
            const anon = await (await import('supertest')).default(app.getHttpServer()).get('/api/v1/my-day');
            expect(anon.status).toBe(401);
        });
    });
});
