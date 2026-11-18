/**
 * Calls, messages, notes and follow-up tasks on a lead, against a REAL MySQL/MariaDB database: the outcomes, what
 * logging a call does to the lead (contact stage, attempts, opportunity), follow-up tasks, who may do what.
 * Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- engagement
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

describe.skipIf(!enabled)('calls, notes and tasks (real database)', () => {
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
    const fresh = (id: bigint) => db.lead.findUniqueOrThrow({ where: { id } });
    const eventTypes = async (id: bigint) => (await db.leadEvent.findMany({ where: { leadId: id }, orderBy: { id: 'asc' } })).map((e) => e.type);

    describe('the outcomes', () => {
        it('are listed for everyone who works leads, with what each one asks for', async () => {
            for (const key of ['bda1', 'ops', 'manager']) {
                const s = await session(key);
                const res = await s.agent.get('/api/v1/engagement/outcomes');
                expect(res.status).toBe(200);
                const byName = Object.fromEntries(res.body.map((o: { name: string }) => [o.name, o]));
                expect(res.body).toHaveLength(OUTCOMES.length);
                expect(byName['Connected']).toMatchObject({ connected: true, requiresFollowup: true, ends: false });
                expect(byName['No answer']).toMatchObject({ connected: false, requiresFollowup: true, ends: false });
                expect(byName['Wrong number']).toMatchObject({ requiresFollowup: false, ends: true });
                expect(byName['Not interested']).toMatchObject({ ends: true });
            }
        });
    });

    describe('logging a call', () => {
        it('saves it, moves the contact stage, sets a follow-up and shows on the timeline', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const due = hoursFromNow(26);
            const res = await log(bda, lead, { kind: 'CALL', outcomeId: outcome['Connected'], notes: 'Wants a weekend slot', nextStep: { title: 'Send the test link', dueAt: due } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.lead.lifecycle).toBe('ENGAGED_LEAD');
            expect(res.body.lead.lastActivityAt).not.toBeNull();
            expect(res.body.events[0].title).toBe('Follow-up set');
            expect(res.body.events.map((e: { title: string }) => e.title)).toEqual(expect.arrayContaining(['Call: Connected']));

            const after = await fresh(lead.id);
            expect(after.firstTouchAt).not.toBeNull();
            expect(after.attemptCount).toBe(0);
            expect(after.nextFollowupAt?.toISOString()).toBe(new Date(due).toISOString());
            const activity = await db.activity.findFirstOrThrow({ where: { leadId: lead.id } });
            expect(activity).toMatchObject({ kind: 'CALL', connected: true, notes: 'Wants a weekend slot', userId: users.bda1.id });
            const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
            expect(task).toMatchObject({ type: 'FOLLOW_UP', status: 'OPEN', title: 'Send the test link', assigneeId: users.bda1.id });
            expect(await eventTypes(lead.id)).toEqual(['ACTIVITY_LOGGED', 'CONTACT_STAGE_CHANGED', 'OPPORTUNITY_STAGE_CHANGED', 'TASK_CREATED']);
        });

        it('asks for the next follow-up when the outcome needs one', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const res = await log(bda, lead, { kind: 'CALL', outcomeId: outcome['No answer'] });
            expect(res.status).toBe(400);
            expect(res.body.fields.nextStep).toBe('Choose when to follow up');
            expect(await db.activity.count()).toBe(0);
            expect((await fresh(lead.id)).attemptCount).toBe(0);
        });

        it('a new call answers the follow-up that was waiting and replaces it with the next step', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'Call back later', { nextStep: { title: 'First', dueAt: hoursFromNow(2) } });
            await call(bda, lead, 'Call back later', { nextStep: { title: 'Second', dueAt: hoursFromNow(48) } });
            const tasks = await db.task.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
            expect(tasks.map((t) => [t.title, t.status])).toEqual([['First', 'DONE'], ['Second', 'OPEN']]);
            expect(tasks[0].completedAt).not.toBeNull();
            expect((await fresh(lead.id)).nextFollowupAt?.getTime()).toBe(tasks[1].dueAt.getTime());
        });

        it('counts unanswered calls and marks a lead who never connected Exhausted after the third', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            for (const [i, name] of ['No answer', 'Busy', 'Switched off'].entries()) {
                const res = await call(bda, lead, name);
                expect(res.status, JSON.stringify(res.body)).toBe(200);
                expect((await fresh(lead.id)).attemptCount).toBe(i + 1);
                expect(res.body.lead.lifecycle).toBe(i < 2 ? 'MARKETING_LEAD' : 'EXHAUSTED_NOT_CONNECTED');
            }
            const attempts = (await db.activity.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } })).map((a) => a.attemptNo);
            expect(attempts).toEqual([1, 2, 3]);
            const res = await (await bda.agent.get(`/api/v1/leads/${lead.publicId}`)).body;
            expect(res.events.some((e: { title: string; sub: string }) => e.title === 'Call: Switched off' && e.sub.startsWith('Attempt 3'))).toBe(true);
        });

        it('a connected call starts the count again, and a lead who connected once is not made Exhausted', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'No answer');
            await call(bda, lead, 'No answer');
            expect((await fresh(lead.id)).attemptCount).toBe(2);
            await call(bda, lead, 'Call back later');
            expect((await fresh(lead.id)).attemptCount).toBe(0);
            for (let i = 0; i < 3; i += 1) await call(bda, lead, 'No answer');
            const after = await fresh(lead.id);
            expect(after.attemptCount).toBe(3);
            expect(after.lifecycleStage).toBe('MARKETING_LEAD');
        });

        it('the first real conversation moves Call 1 Pending to Call 1; a call nobody picked does not', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const stage = async () => (await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id, status: 'OPEN' } })).stage;
            await call(bda, lead, 'No answer');
            await call(bda, lead, 'Busy');
            await call(bda, lead, 'Switched off');
            await call(bda, lead, 'Call back later'); // picked up, but busy: not a conversation yet
            expect(await stage()).toBe('CALL_1_PENDING');
            const res = await call(bda, lead, 'Connected');
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.lead.stage).toBe('CALL_1');
            expect(await stage()).toBe('CALL_1');
            const moved = res.body.events.find((e: { title: string }) => e.title === 'Moved to Call 1');
            expect(moved?.sub).toContain('From Call 1 Pending');
            await call(bda, lead, 'Interested');
            expect(await stage()).toBe('CALL_1');
            expect((await db.opportunityStageChange.count({ where: { opportunity: { leadId: lead.id } } }))).toBe(1);
        });

        it('never pulls a lead back from a later stage, and respects a stage picked in the same step', async () => {
            const later = await makeLead(1);
            await db.opportunity.updateMany({ where: { leadId: later.id }, data: { stage: 'TEST' } });
            const bda = await session('bda1');
            await call(bda, later, 'Connected');
            expect((await db.opportunity.findFirstOrThrow({ where: { leadId: later.id } })).stage).toBe('TEST');

            const picked = await makeLead(2);
            const res = await call(bda, picked, 'Connected', { stage: 'CALL_2' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.lead.stage).toBe('CALL_2');
        });

        it('"Not interested" does not move the stage forward', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await log(bda, lead, { kind: 'CALL', outcomeId: outcome['Not interested'] });
            expect((await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id } })).stage).toBe('CALL_1_PENDING');
        });

        it('only ever moves the contact stage forward, and leaves enrolled leads alone', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'Interested');
            expect((await fresh(lead.id)).lifecycleStage).toBe('PROSPECT');
            await call(bda, lead, 'Connected');
            expect((await fresh(lead.id)).lifecycleStage).toBe('PROSPECT');

            const enrolled = await makeLead(2, { lifecycle: 'ENROLLED' });
            const manager = await session('manager');
            const res = await log(manager, enrolled, { kind: 'CALL', outcomeId: outcome['Connected'], nextStep: { title: 'Welcome call', dueAt: hoursFromNow(5) } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect((await fresh(enrolled.id)).lifecycleStage).toBe('ENROLLED');
        });

        it('a wrong number closes the opportunity as lost and drops the waiting follow-ups', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'Call back later');
            const res = await log(bda, lead, { kind: 'CALL', outcomeId: outcome['Wrong number'] });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.opportunity).toMatchObject({ status: 'LOST', lostReason: 'Wrong Number' });
            const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
            expect(task.status).toBe('CANCELLED');
            expect((await fresh(lead.id)).nextFollowupAt).toBeNull();
            expect(await eventTypes(lead.id)).toContain('OPPORTUNITY_LOST');
        });

        it('"Not interested" ends the sales follow-up but leaves the opportunity for a person to close', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'Call back later');
            const res = await log(bda, lead, { kind: 'CALL', outcomeId: outcome['Not interested'], nextStep: { title: 'ignored', dueAt: hoursFromNow(5) } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.lead.lifecycle).toBe('NOT_INTERESTED');
            expect(res.body.opportunity.status).toBe('OPEN');
            expect((await db.task.findMany({ where: { leadId: lead.id } })).map((t) => t.status)).toEqual(['CANCELLED']);
        });

        it('can move the stage and set the temperature in the same step, which also changes the call order', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const res = await call(bda, lead, 'Interested', { stage: 'CALL_1', temperature: 'HOT' });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.lead).toMatchObject({ stage: 'CALL_1', temperature: 'HOT' });
            const after = await fresh(lead.id);
            expect(after.priorityRank).toBe(300);
            expect(await eventTypes(lead.id)).toEqual(expect.arrayContaining(['OPPORTUNITY_STAGE_CHANGED', 'TEMPERATURE_CHANGED']));
        });

        it('needs the test date when the call moves the lead to Test, and keeps it', async () => {
            const lead = await makeLead(2);
            const bda = await session('bda1');
            const missing = await call(bda, lead, 'Interested', { stage: 'TEST' });
            expect(missing.status).toBe(400);
            expect(await db.activity.count()).toBe(0);
            const on = new Date(Date.now() + 330 * 60_000 + 4 * 86_400_000).toISOString().slice(0, 10);
            const res = await call(bda, lead, 'Interested', { stage: 'TEST', stageDate: on });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.opportunity).toMatchObject({ stage: 'TEST', testOn: on });
        });

        it('stops everything when the stage move is refused', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const res = await call(bda, lead, 'Interested', { stage: 'CLOSED_WON' });
            expect(res.status).toBe(403);
            expect(await db.activity.count()).toBe(0);
            expect(await db.task.count()).toBe(0);
        });

        it('refuses what does not make sense and stores nothing', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const field = async (body: Record<string, unknown>) => {
                const res = await log(bda, lead, body);
                expect(res.status, JSON.stringify(res.body)).toBe(400);
                return res.body.fields ?? {};
            };
            expect(await field({ kind: 'CALL' })).toHaveProperty('outcomeId');
            expect(await field({ kind: 'CALL', outcomeId: 99999, nextStep: { title: 'x', dueAt: hoursFromNow(1) } })).toHaveProperty('outcomeId');
            expect(await field({ kind: 'NOTE', outcomeId: outcome['Connected'], notes: 'hi' })).toHaveProperty('outcomeId');
            expect(await field({ kind: 'NOTE' })).toHaveProperty('notes');
            expect(await field({ kind: 'NOTE', notes: 'x'.repeat(2001) })).toHaveProperty('notes');
            expect(await field({ kind: 'CALL', outcomeId: outcome['Connected'], nextStep: { title: 'x', dueAt: hoursFromNow(-3) } })).toHaveProperty('nextStep');
            expect(await field({ kind: 'CALL', outcomeId: outcome['Connected'], nextStep: { title: 'x', dueAt: hoursFromNow(24 * 400) } })).toHaveProperty('nextStep');
            expect(await field({ kind: 'CALL', outcomeId: outcome['Connected'], nextStep: { title: '', dueAt: hoursFromNow(1) } })).toBeTruthy();
            expect(await field({ kind: 'FAX' })).toBeTruthy();
            expect(await db.activity.count()).toBe(0);
        });
    });

    describe('messages and notes', () => {
        it('are logged without an outcome, do not count as attempts, and do not answer a waiting follow-up', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'No answer');
            expect((await log(bda, lead, { kind: 'WHATSAPP', notes: 'Sent the brochure' })).status).toBe(200);
            expect((await log(bda, lead, { kind: 'EMAIL', notes: 'Sent the fee structure' })).status).toBe(200);
            const note = await log(bda, lead, { kind: 'NOTE', notes: 'Parent is the decision maker' });
            expect(note.status, JSON.stringify(note.body)).toBe(200);
            expect(note.body.events.map((e: { title: string }) => e.title)).toEqual(expect.arrayContaining(['WhatsApp message logged', 'Email logged', 'Note added']));
            const after = await fresh(lead.id);
            expect(after.attemptCount).toBe(1);
            expect((await db.task.findMany({ where: { leadId: lead.id } })).map((t) => t.status)).toEqual(['OPEN']);
            expect(await db.activity.count({ where: { leadId: lead.id } })).toBe(4);
        });

        it('can carry a next step, which is added next to the follow-up already waiting', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await call(bda, lead, 'Call back later', { nextStep: { title: 'Call', dueAt: hoursFromNow(30) } });
            await log(bda, lead, { kind: 'WHATSAPP', notes: 'Sent details', nextStep: { title: 'Ask if they read it', dueAt: hoursFromNow(5) } });
            const open = await db.task.findMany({ where: { leadId: lead.id, status: 'OPEN' }, orderBy: { dueAt: 'asc' } });
            expect(open.map((t) => t.title)).toEqual(['Ask if they read it', 'Call']);
            expect((await fresh(lead.id)).nextFollowupAt?.getTime()).toBe(open[0].dueAt.getTime());
        });
    });

    describe('the lead\'s activity and tasks', () => {
        it('lists the notes with who wrote them, and the open tasks first', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            await log(bda, lead, { kind: 'NOTE', notes: 'First note' });
            await call(bda, lead, 'Connected', { notes: 'Spoke for ten minutes', nextStep: { title: 'Send test', dueAt: hoursFromNow(3) } });
            const res = await bda.agent.get(`/api/v1/leads/${lead.publicId}/engagement`);
            expect(res.status).toBe(200);
            expect(res.body.activities.map((a: { notes: string }) => a.notes)).toEqual(['Spoke for ten minutes', 'First note']);
            expect(res.body.activities[0]).toMatchObject({ kind: 'CALL', outcome: { name: 'Connected' }, by: 'BDA Bose', connected: true });
            expect(res.body.tasks).toHaveLength(1);
            expect(res.body.tasks[0]).toMatchObject({ title: 'Send test', status: 'OPEN', overdue: false, assignee: 'BDA Bose', type: 'FOLLOW_UP' });
        });
    });

    describe('tasks', () => {
        it('are created, shown as overdue when late, and completed', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const made = await bda.agent.post(`/api/v1/leads/${lead.publicId}/tasks`).set('X-CSRF-Token', bda.csrf).send({ title: 'Check in', dueAt: hoursFromNow(2) });
            expect(made.status, JSON.stringify(made.body)).toBe(200);
            expect(made.body.tasks[0]).toMatchObject({ title: 'Check in', status: 'OPEN', assignee: 'BDA Bose' });
            expect((await fresh(lead.id)).nextFollowupAt).not.toBeNull();

            const id = made.body.tasks[0].id as string;
            await db.task.update({ where: { id: BigInt(id) }, data: { dueAt: new Date(Date.now() - 3_600_000) } });
            const listed = await bda.agent.get(`/api/v1/leads/${lead.publicId}/engagement`);
            expect(listed.body.tasks[0].overdue).toBe(true);

            const done = await bda.agent.post(`/api/v1/tasks/${id}/complete`).set('X-CSRF-Token', bda.csrf);
            expect(done.status, JSON.stringify(done.body)).toBe(200);
            expect(done.body.tasks[0]).toMatchObject({ status: 'DONE', overdue: false });
            expect((await fresh(lead.id)).nextFollowupAt).toBeNull();
            expect(await eventTypes(lead.id)).toEqual(expect.arrayContaining(['TASK_CREATED', 'TASK_DONE']));

            const again = await bda.agent.post(`/api/v1/tasks/${id}/complete`).set('X-CSRF-Token', bda.csrf);
            expect(again.status).toBe(409);
        });

        it('can be cancelled, and the next follow-up falls back to the one that is left', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const a = await bda.agent.post(`/api/v1/leads/${lead.publicId}/tasks`).set('X-CSRF-Token', bda.csrf).send({ title: 'Soon', dueAt: hoursFromNow(2) });
            const later = hoursFromNow(30);
            await bda.agent.post(`/api/v1/leads/${lead.publicId}/tasks`).set('X-CSRF-Token', bda.csrf).send({ title: 'Later', dueAt: later });
            const cancelled = await bda.agent.post(`/api/v1/tasks/${a.body.tasks[0].id}/cancel`).set('X-CSRF-Token', bda.csrf);
            expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
            expect((await fresh(lead.id)).nextFollowupAt?.toISOString()).toBe(new Date(later).toISOString());
        });

        it('refuse a past time and an empty title', async () => {
            const lead = await makeLead(1);
            const bda = await session('bda1');
            const post = (body: Record<string, unknown>) => bda.agent.post(`/api/v1/leads/${lead.publicId}/tasks`).set('X-CSRF-Token', bda.csrf).send(body);
            expect((await post({ title: 'Late', dueAt: hoursFromNow(-5) })).status).toBe(400);
            expect((await post({ title: '  ', dueAt: hoursFromNow(5) })).status).toBe(400);
            expect(await db.task.count()).toBe(0);
        });
    });

    describe('who may do what', () => {
        it('a BDA cannot log on, read or close tasks of someone else\'s lead', async () => {
            const lead = await makeLead(1, { owner: 'bda2' });
            const task = await db.task.create({ data: { leadId: lead.id, assigneeId: users.bda2.id, type: 'FOLLOW_UP', title: 'Theirs', dueAt: new Date(Date.now() + 3_600_000) } });
            const bda = await session('bda1');
            expect((await log(bda, lead, { kind: 'NOTE', notes: 'hi' })).status).toBe(404);
            expect((await bda.agent.get(`/api/v1/leads/${lead.publicId}/engagement`)).status).toBe(404);
            expect((await bda.agent.post(`/api/v1/leads/${lead.publicId}/tasks`).set('X-CSRF-Token', bda.csrf).send({ title: 'x', dueAt: hoursFromNow(2) })).status).toBe(404);
            expect((await bda.agent.post(`/api/v1/tasks/${task.id}/complete`).set('X-CSRF-Token', bda.csrf)).status).toBe(404);
            expect(await db.activity.count()).toBe(0);
        });

        it('operations can read but not log; managers and admins can log on any lead', async () => {
            const lead = await makeLead(1);
            const ops = await session('ops');
            expect((await ops.agent.get(`/api/v1/leads/${lead.publicId}/engagement`)).status).toBe(200);
            expect((await log(ops, lead, { kind: 'NOTE', notes: 'hi' })).status).toBe(403);
            for (const key of ['manager', 'admin']) {
                const s = await session(key);
                expect((await log(s, lead, { kind: 'NOTE', notes: `from ${key}` })).status).toBe(200);
            }
            expect(await db.activity.count()).toBe(2);
        });

        it('a lead nobody owns gets its follow-up assigned to the person who set it', async () => {
            const lead = await makeLead(1, { owner: null });
            const manager = await session('manager');
            const res = await call(manager, lead, 'Connected');
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).assigneeId).toBe(users.manager.id);
        });

        it('needs a session and the CSRF token', async () => {
            const lead = await makeLead(1);
            const supertest = (await import('supertest')).default;
            await supertest(app.getHttpServer()).post(`/api/v1/leads/${lead.publicId}/activities`).send({ kind: 'NOTE', notes: 'x' }).expect(401);
            const bda = await session('bda1');
            const res = await bda.agent.post(`/api/v1/leads/${lead.publicId}/activities`).send({ kind: 'NOTE', notes: 'x' });
            expect(res.status).toBe(403);
        });
    });
});
