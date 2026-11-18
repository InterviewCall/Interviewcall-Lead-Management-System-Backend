/**
 * The lead score growing on its own (from calls, stages and the VSL steps) and catching up old leads, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- lead-scoring
 */
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ModelService } from '@app/model';
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from '@app/rate-limit';
import { AppModule } from '../src/app.module.js';
import { LeadsRepository } from '../src/modules/leads/leads.repository.js';
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
const OUTCOMES = [
    { name: 'Connected', effect: { connected: true, lifecycle: 'ENGAGED_LEAD' }, requiresFollowup: true },
    { name: 'No answer', effect: { connected: false, countsAsAttempt: true }, requiresFollowup: true },
];

describe.skipIf(!enabled)('Lead scoring (real database)', () => {
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
        await make('bda3', 'BDA Sen', 'BDA');
        await make('closer', 'Closer Chen', 'CLOSER');
        await make('ops', 'Ops Omar', 'OPS');
        await db.leadSource.create({ data: { name: 'WorkR', group: 'WORKR' } });
        await db.leadSource.create({ data: { name: 'Organic', group: 'ORGANIC' } });
        await db.leadSource.create({ data: { name: 'Old source', group: 'META', isActive: false } });
        for (const [index, o] of OUTCOMES.entries()) outcome[o.name] = (await db.outcome.create({ data: { ...o, sortOrder: index } })).id;
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

    const scoreOf = async (id: bigint) => (await db.lead.findUniqueOrThrow({ where: { id } })).leadScore;
    const reasonsOf = async (id: bigint) => (await db.leadScoreEntry.findMany({ where: { leadId: id }, orderBy: { id: 'asc' } })).map((e) => [e.reason, e.points]);
    const inADay = () => new Date(Date.now() + 86_400_000).toISOString();

    describe('as the team works a lead', () => {
        it('grows with a connected call and what it leads to, and not with an unanswered one', async () => {
            const lead = await makeLead(1, { owner: 'bda1' });
            await db.opportunity.updateMany({ where: { leadId: lead.id }, data: { stage: 'CALL_1_PENDING' } });

            const missed = await post('bda1', `/leads/${lead.publicId}/activities`, { kind: 'CALL', outcomeId: outcome['No answer'], nextStep: { title: 'Try again', dueAt: inADay() } });
            expect(missed.status, JSON.stringify(missed.body)).toBe(200);
            expect(await scoreOf(lead.id)).toBe(0);

            const res = await post('bda1', `/leads/${lead.publicId}/activities`, { kind: 'CALL', outcomeId: outcome.Connected, nextStep: { title: 'Send the test link', dueAt: inADay() } });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const reasons = await reasonsOf(lead.id);
            expect(reasons).toEqual(expect.arrayContaining([['CALL_CONNECTED', 10], ['CONTACT_STAGE_ENGAGED_LEAD', 5], ['PIPELINE_CALL_1', 10]]));
            expect(await scoreOf(lead.id)).toBe(25);
            // The lead page returned by the call already shows the new score.
            expect(res.body.lead.score).toBe(25);
        });

        it('counts each stage once, even when a lead goes back and forward again', async () => {
            const lead = await makeLead(2, { owner: 'bda1' });
            for (const stage of ['TEST', 'CALL_1', 'TEST']) {
                const res = await post('manager', `/leads/${lead.publicId}/opportunity/stage`, { stage, ...(stage === 'TEST' ? { date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) } : {}) });
                expect(res.status, JSON.stringify(res.body)).toBe(200);
            }
            expect(await reasonsOf(lead.id)).toEqual([['PIPELINE_TEST', 10], ['PIPELINE_CALL_1', 10]]);
            expect(await scoreOf(lead.id)).toBe(20);

            await post('manager', `/leads/${lead.publicId}/contact-stage`, { stage: 'NOT_INTERESTED' });
            expect(await scoreOf(lead.id)).toBe(-5);
        });
    });

    describe('catching up leads from before scoring', () => {
        it('adds what their history earns, including the newest form score, and never counts anything twice', async () => {
            const lead = await makeLead(3);
            await db.leadEvent.createMany({
                data: [
                    { type: 'LEAD_CREATED', actorType: 'SOURCE' as const, data: { via: 'VSL', step: 'DETAILS' } },
                    { type: 'SLOT_BOOKED', actorType: 'SOURCE' as const, data: { slot: 'Thu 4 pm', booking: 'b-1' } },
                    { type: 'OPPORTUNITY_STAGE_CHANGED', actorType: 'USER' as const, data: { from: 'CALL_1', to: 'TEST' } },
                    { type: 'TASK_CREATED', actorType: 'USER' as const, data: { task: '1' } },
                ].map((e) => ({ ...e, leadId: lead.id, occurredAt: new Date(Date.now() - 3 * 86_400_000) })),
            });
            await db.formResponse.create({ data: { leadId: lead.id, formSlug: 'job-switch', submissionRef: 'old-form', score: 60, answers: [], submittedAt: new Date(Date.now() - 2 * 86_400_000) } });
            await db.formResponse.create({ data: { leadId: lead.id, formSlug: 'job-switch', submissionRef: 'new-form', score: 80, answers: [], submittedAt: new Date(Date.now() - 86_400_000) } });

            // The team has tried this lead, so what the VSL gave it counts.
            await db.activity.create({ data: { leadId: lead.id, userId: users.bda1.id, kind: 'CALL', connected: false } });

            expect((await post('manager', '/scores/recalculate', {})).status).toBe(403);
            const res = await post('admin', '/scores/recalculate', {});
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({ leads: 1, points: 115 });
            expect(await scoreOf(lead.id)).toBe(5 + 20 + 10 + 80);

            const again = await post('admin', '/scores/recalculate', {});
            expect(again.body).toMatchObject({ leads: 0, points: 0 });
            expect(await scoreOf(lead.id)).toBe(115);
        });

        it('holds the VSL points until the team has tried the lead, then releases them', async () => {
            const lead = await makeLead(4, { owner: 'bda1' });
            await db.opportunity.updateMany({ where: { leadId: lead.id }, data: { stage: 'CALL_1_PENDING' } });
            await db.leadEvent.createMany({
                data: [
                    { type: 'LEAD_CREATED', actorType: 'SOURCE' as const, data: { via: 'VSL', step: 'DETAILS' } },
                    { type: 'SLOT_BOOKED', actorType: 'SOURCE' as const, data: { slot: 'Thu 4 pm', booking: 'b-4' } },
                ].map((e) => ({ ...e, leadId: lead.id, occurredAt: new Date(Date.now() - 86_400_000) })),
            });
            await db.formResponse.create({ data: { leadId: lead.id, formSlug: 'job-switch', submissionRef: 'form-4', score: 70, answers: [], submittedAt: new Date(Date.now() - 86_400_000) } });

            // Nobody has called yet: nothing counts, however often the scores are worked out again.
            expect((await post('admin', '/scores/recalculate', {})).body).toMatchObject({ leads: 0, points: 0 });
            expect(await scoreOf(lead.id)).toBe(0);

            // A note is not an attempt.
            const note = await post('bda1', `/leads/${lead.publicId}/activities`, { kind: 'NOTE', notes: 'Looked at the form answers' });
            expect(note.status, JSON.stringify(note.body)).toBe(200);
            expect(await scoreOf(lead.id)).toBe(0);

            // A call nobody picked is an attempt: the VSL points are released, and the score grows from there.
            const missed = await post('bda1', `/leads/${lead.publicId}/activities`, { kind: 'CALL', outcomeId: outcome['No answer'], nextStep: { title: 'Try again', dueAt: inADay() } });
            expect(missed.status, JSON.stringify(missed.body)).toBe(200);
            expect(await scoreOf(lead.id)).toBe(5 + 20 + 70);
            expect(missed.body.lead.score).toBe(95);

            // Counted once: another attempt adds nothing, a connected call adds its own points.
            const again = await post('bda1', `/leads/${lead.publicId}/activities`, { kind: 'CALL', outcomeId: outcome['No answer'], nextStep: { title: 'Try again', dueAt: inADay() } });
            expect(again.status, JSON.stringify(again.body)).toBe(200);
            expect(await scoreOf(lead.id)).toBe(95);
        });

        it('takes the VSL points back from leads nobody has tried yet, and leaves everything else alone', async () => {
            const untouched = await makeLead(5);
            const worked = await makeLead(6);
            for (const lead of [untouched, worked]) {
                await db.leadScoreEntry.createMany({
                    data: [
                        { leadId: lead.id, points: 5, reason: 'VSL_DETAILS', ref: 'once' },
                        { leadId: lead.id, points: 60, reason: 'VSL_FORM_SCORE', ref: 'vsl:form:x' },
                        { leadId: lead.id, points: 7, reason: 'IMPORT_INITIAL', ref: null },
                    ],
                });
                await db.lead.update({ where: { id: lead.id }, data: { leadScore: 72 } });
            }
            await db.activity.create({ data: { leadId: worked.id, userId: users.bda1.id, kind: 'NOTE', notes: 'a note is not an attempt' } });
            await db.activity.create({ data: { leadId: worked.id, userId: users.bda1.id, kind: 'CALL', connected: false } });

            const changed = await app.get(LeadsRepository).holdVslPoints(['VSL_DETAILS', 'VSL_SLOT_BOOKED', 'VSL_FORM_SCORE']);
            expect(changed).toBe(1);
            expect(await scoreOf(untouched.id)).toBe(7);
            expect(await reasonsOf(untouched.id)).toEqual([['IMPORT_INITIAL', 7]]);
            expect(await scoreOf(worked.id)).toBe(72);
        });

        it('shows everyone the rules', async () => {
            const res = await (await session('bda1')).agent.get('/api/v1/scores/rules');
            expect(res.status).toBe(200);
            expect(res.body.rules).toEqual(expect.arrayContaining([{ label: 'Booked a counselling call', points: 20, once: true }]));
        });
    });
});
