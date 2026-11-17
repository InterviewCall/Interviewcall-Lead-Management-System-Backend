/**
 * The Reports screen against a REAL MySQL/MariaDB database: new leads, contact within an hour, the funnel, leads by
 * source, the BDA table and why opportunities were lost, for the team and for a BDA. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- reports
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

describe.skipIf(!enabled)('Reports (real database)', () => {
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
        await make('closer', 'Closer Chen', 'CLOSER');
        await make('ops', 'Ops Omar', 'OPS');
        await db.leadSource.create({ data: { name: 'WorkR', group: 'WORKR' } });
        await db.leadSource.create({ data: { name: 'VSL job-switch', group: 'VSL' } });
        await db.lostReason.create({ data: { name: 'Out of TG' } });
        await db.lostReason.create({ data: { name: 'Financial constraint' } });
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
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const ago = (ms: number) => new Date(Date.now() - ms);

    interface Made {
        owner?: string | null;
        source?: 'WorkR' | 'VSL job-switch';
        /** How long ago the lead arrived. */
        arrivedAgo?: number;
        /** How long after arriving the first call was made; absent when never contacted. */
        touchedAfter?: number;
        merged?: boolean;
    }

    async function makeLead(n: number, over: Made = {}) {
        const source = await db.leadSource.findFirstOrThrow({ where: { name: over.source ?? 'WorkR' } });
        const ownerId = over.owner === null ? null : users[over.owner ?? 'bda1'].id;
        const capturedAt = ago(over.arrivedAgo ?? 2 * DAY);
        return db.lead.create({
            data: {
                fullName: `Person ${n}`, email: `p${n}@example.com`, phoneLast10: mobile(n), phoneE164: `+91${mobile(n)}`,
                ownerId, firstSourceId: source.id, capturedAt,
                firstTouchAt: over.touchedAfter === undefined ? null : new Date(capturedAt.getTime() + over.touchedAfter),
                mergedIntoId: over.merged ? (await db.lead.findFirstOrThrow({ select: { id: true } })).id : null,
                identities: { create: [{ type: 'EMAIL', value: `p${n}@example.com` }, { type: 'PHONE', value: mobile(n) }] },
            },
        });
    }

    type Stage = 'CALL_1_PENDING' | 'CALL_1' | 'TEST' | 'CALL_2' | 'PSYCHOMETRIC_SESSION' | 'DECISION_OBJECTION' | 'PAYMENT_FINANCING' | 'CLOSED_WON';
    interface Opp {
        openedAgo?: number;
        status?: 'OPEN' | 'WON' | 'LOST';
        closedAgo?: number;
        stage?: Stage;
        /** Stages it passed through, as the history rows. */
        history?: Stage[];
        lostReason?: string;
    }

    async function makeOpp(lead: { id: bigint; ownerId: bigint | null }, over: Opp = {}) {
        const status = over.status ?? 'OPEN';
        const stage = status === 'WON' ? 'CLOSED_WON' : (over.stage ?? 'CALL_1_PENDING');
        const opp = await db.opportunity.create({
            data: {
                leadId: lead.id, openLeadId: status === 'OPEN' ? lead.id : null, stage, status, ownerId: lead.ownerId,
                openedAt: ago(over.openedAgo ?? DAY),
                closedAt: status === 'OPEN' ? null : ago(over.closedAgo ?? 0),
                ...(over.lostReason ? { lostReasonId: (await db.lostReason.findFirstOrThrow({ where: { name: over.lostReason } })).id } : {}),
            },
        });
        for (const to of over.history ?? []) {
            await db.opportunityStageChange.create({ data: { opportunityId: opp.id, toStage: to } });
        }
        return opp;
    }

    const call = (leadId: bigint, userKey: string, connected: boolean, at = new Date()) =>
        db.activity.create({ data: { leadId, userId: users[userKey].id, kind: 'CALL', connected, occurredAt: at } });

    const report = async (key: string, query = '') => {
        const s = await session(key);
        const res = await s.agent.get(`/api/v1/reports/summary${query}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as {
            days: number;
            kpis: { newLeads: number; newLeadsChange: number | null; contactedPct: number | null; contactedChange: number | null; opps: number; enrolled: number };
            funnel: Array<{ stage: string; count: number; fromPrev: number | null }>;
            weeks: Array<{ weekStart: string; values: Record<string, number> }>;
            sources: string[];
            bdas: Array<{ id: string; name: string; leads: number; contactedPct: number | null; connectPct: number | null; opps: number; won: number }>;
            lost: { total: number; reasons: Array<{ reason: string; count: number }> };
        };
    };

    describe('new leads', () => {
        it('counts the leads that arrived in the range, and compares with the same length before it', async () => {
            await makeLead(1, { arrivedAgo: 2 * DAY });
            await makeLead(2, { arrivedAgo: 6 * DAY });
            await makeLead(3, { arrivedAgo: 9 * DAY }); // before the 7 days, inside the 7 before
            await makeLead(4, { arrivedAgo: 20 * DAY }); // before both
            const r = await report('manager', '?days=7');
            expect(r.days).toBe(7);
            expect(r.kpis.newLeads).toBe(2);
            expect(r.kpis.newLeadsChange).toBe(100); // 2 against 1
            expect((await report('manager', '?days=30')).kpis.newLeads).toBe(4);
        });

        it('has no change to report when nothing arrived in the period before', async () => {
            await makeLead(1, { arrivedAgo: DAY });
            expect((await report('manager', '?days=7')).kpis.newLeadsChange).toBeNull();
        });

        it('leaves out leads that were merged into another', async () => {
            await makeLead(1);
            await makeLead(2, { merged: true });
            expect((await report('manager')).kpis.newLeads).toBe(1);
        });

        it('defaults to 30 days and rejects other ranges', async () => {
            expect((await report('manager')).days).toBe(30);
            const s = await session('manager');
            expect((await s.agent.get('/api/v1/reports/summary?days=5')).status).toBe(400);
            expect((await s.agent.get('/api/v1/reports/summary?source=NOPE')).status).toBe(400);
        });
    });

    describe('contacted within an hour', () => {
        it('is the share of leads first called within an hour of arriving', async () => {
            await makeLead(1, { touchedAfter: 10 * 60_000 });
            await makeLead(2, { touchedAfter: 59 * 60_000 });
            await makeLead(3, { touchedAfter: 3 * HOUR });
            await makeLead(4);
            const r = await report('manager');
            expect(r.kpis.contactedPct).toBe(50);
        });

        it('does not count a lead that arrived under an hour ago and has not been called yet', async () => {
            await makeLead(1, { arrivedAgo: 20 * 60_000 });
            await makeLead(2, { arrivedAgo: 30 * 60_000, touchedAfter: 5 * 60_000 });
            await makeLead(3, { arrivedAgo: 2 * HOUR });
            const r = await report('manager');
            expect(r.kpis.newLeads).toBe(3);
            expect(r.kpis.contactedPct).toBe(50); // 1 of the 2 whose hour is over or who were called
        });

        it('is empty when no lead can be judged yet, and shows the change in points', async () => {
            expect((await report('manager')).kpis.contactedPct).toBeNull();
            await makeLead(1, { arrivedAgo: 2 * DAY, touchedAfter: 5 * 60_000 }); // this period: 100%
            await makeLead(2, { arrivedAgo: 10 * DAY, touchedAfter: 5 * 60_000 }); // before: 50%
            await makeLead(3, { arrivedAgo: 10 * DAY });
            const r = await report('manager', '?days=7');
            expect(r.kpis.contactedPct).toBe(100);
            expect(r.kpis.contactedChange).toBe(50);
        });
    });

    describe('the funnel', () => {
        it('counts each opportunity at every stage up to the furthest it reached', async () => {
            const a = await makeLead(1);
            const b = await makeLead(2);
            const c = await makeLead(3);
            const d = await makeLead(4);
            await makeOpp(a, { stage: 'CALL_1', history: ['CALL_1_PENDING', 'CALL_1'] });
            await makeOpp(b, { stage: 'CALL_1_PENDING', history: ['CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_1_PENDING'] }); // went back, still reached Test
            await makeOpp(c, { status: 'WON', history: ['CALL_1_PENDING', 'CLOSED_WON'] }); // jumped straight to won
            await makeOpp(d, { stage: 'CALL_2' }); // no history rows: its current stage counts
            const r = await report('manager');
            expect(r.funnel.map((f) => f.stage)).toEqual(['CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_2', 'PSYCHOMETRIC_SESSION', 'DECISION_OBJECTION', 'PAYMENT_FINANCING', 'CLOSED_WON']);
            expect(r.funnel.map((f) => f.count)).toEqual([4, 4, 3, 2, 1, 1, 1, 1]);
            expect(r.funnel.map((f) => f.fromPrev)).toEqual([null, 100, 75, 67, 50, 100, 100, 100]);
            expect(r.kpis.opps).toBe(4);
        });

        it('only looks at opportunities opened in the range', async () => {
            await makeOpp(await makeLead(1), { openedAgo: 2 * DAY });
            await makeOpp(await makeLead(2), { openedAgo: 40 * DAY });
            expect((await report('manager', '?days=30')).funnel[0].count).toBe(1);
            expect((await report('manager', '?days=90')).funnel[0].count).toBe(2);
        });

        it('is all zeros, without dividing by zero, when nothing was opened', async () => {
            const r = await report('manager');
            expect(r.funnel.every((f) => f.count === 0 && f.fromPrev === null)).toBe(true);
        });
    });

    describe('enrolled and lost', () => {
        it('counts what was won in the range, whenever the opportunity was opened', async () => {
            await makeOpp(await makeLead(1), { status: 'WON', openedAgo: 60 * DAY, closedAgo: 2 * DAY });
            await makeOpp(await makeLead(2), { status: 'WON', openedAgo: 60 * DAY, closedAgo: 45 * DAY });
            expect((await report('manager', '?days=30')).kpis.enrolled).toBe(1);
            expect((await report('manager', '?days=90')).kpis.enrolled).toBe(2);
        });

        it('groups the lost ones by reason, most common first, and names the ones with no reason', async () => {
            await makeOpp(await makeLead(1), { status: 'LOST', closedAgo: DAY, lostReason: 'Out of TG' });
            await makeOpp(await makeLead(2), { status: 'LOST', closedAgo: DAY, lostReason: 'Financial constraint' });
            await makeOpp(await makeLead(3), { status: 'LOST', closedAgo: DAY, lostReason: 'Financial constraint' });
            await makeOpp(await makeLead(4), { status: 'LOST', closedAgo: DAY });
            await makeOpp(await makeLead(5), { status: 'LOST', closedAgo: 50 * DAY, lostReason: 'Out of TG' });
            const r = await report('manager', '?days=30');
            expect(r.lost.total).toBe(4);
            expect(r.lost.reasons).toEqual([
                { reason: 'Financial constraint', count: 2 },
                { reason: 'No reason given', count: 1 },
                { reason: 'Out of TG', count: 1 },
            ]);
        });
    });

    describe('leads by source', () => {
        it('lists four weeks starting on Mondays, with the leads of each source group', async () => {
            await makeLead(1, { arrivedAgo: 60_000, source: 'WorkR' });
            await makeLead(2, { arrivedAgo: 60_000, source: 'VSL job-switch' });
            await makeLead(3, { arrivedAgo: 9 * DAY, source: 'WorkR' });
            await makeLead(4, { arrivedAgo: 60 * DAY, source: 'WorkR' }); // outside the four weeks
            const r = await report('manager');
            expect(r.weeks).toHaveLength(4);
            for (const w of r.weeks) expect(new Date(`${w.weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
            const last = r.weeks[3].values;
            expect(last.WORKR + last.VSL).toBeGreaterThanOrEqual(2);
            const total = (g: string) => r.weeks.reduce((n, w) => n + w.values[g], 0);
            expect(total('WORKR')).toBe(2);
            expect(total('VSL')).toBe(1);
            expect(r.sources).toEqual(['WORKR', 'VSL']);
        });

        it('narrows every figure to one source, while still offering all of them', async () => {
            const a = await makeLead(1, { source: 'WorkR' });
            const b = await makeLead(2, { source: 'VSL job-switch' });
            await makeOpp(a);
            await makeOpp(b);
            const r = await report('manager', '?source=VSL');
            expect(r.kpis.newLeads).toBe(1);
            expect(r.funnel[0].count).toBe(1);
            expect(r.sources).toEqual(['WORKR', 'VSL']);
            expect(r.weeks.reduce((n, w) => n + w.values.WORKR, 0)).toBe(0);
        });
    });

    describe('the BDA table', () => {
        it('has a row for each BDA with their leads, contact rate, connect rate, opportunities and wins, best first', async () => {
            const a1 = await makeLead(1, { owner: 'bda1', touchedAfter: 5 * 60_000 });
            const a2 = await makeLead(2, { owner: 'bda1' });
            const b1 = await makeLead(3, { owner: 'bda2', touchedAfter: 5 * 60_000 });
            await makeOpp(a1, { openedAgo: DAY });
            await makeOpp(a2, { status: 'WON', openedAgo: 5 * DAY, closedAgo: DAY });
            await makeOpp(b1, { openedAgo: DAY });
            await call(a1.id, 'bda1', true);
            await call(a1.id, 'bda1', false);
            await call(a1.id, 'bda1', false);
            await call(a2.id, 'bda1', true);
            await call(b1.id, 'bda2', false);
            const r = await report('manager');
            expect(r.bdas.map((b) => b.name)).toEqual(['BDA Bose', 'BDA Rao']);
            expect(r.bdas[0]).toMatchObject({ leads: 2, contactedPct: 50, connectPct: 50, opps: 2, won: 1 });
            expect(r.bdas[1]).toMatchObject({ leads: 1, contactedPct: 100, connectPct: 0, opps: 1, won: 0 });
            expect(r.bdas[0].id).toBe(users.bda1.publicId);
            expect(JSON.stringify(r)).not.toMatch(/"(id|ownerId|userId)":\d/);
        });

        it('lists an active BDA with nothing yet, with empty rates, and leaves out other roles that own nothing', async () => {
            await makeLead(1, { owner: 'bda1' });
            const r = await report('manager');
            const rao = r.bdas.find((b) => b.name === 'BDA Rao')!;
            expect(rao).toMatchObject({ leads: 0, contactedPct: null, connectPct: null, opps: 0, won: 0 });
            expect(r.bdas.some((b) => b.name === 'Closer Chen' || b.name === 'Admin Anu')).toBe(false);
        });

        it('includes a sales manager who owns leads or makes calls', async () => {
            const lead = await makeLead(1, { owner: 'manager' });
            expect((await report('admin')).bdas.some((b) => b.name === 'Manager Mira')).toBe(true);
            await db.lead.update({ where: { id: lead.id }, data: { ownerId: users.bda1.id } });
            await call(lead.id, 'manager', true);
            expect((await report('admin')).bdas.some((b) => b.name === 'Manager Mira')).toBe(true);
        });

        it('never lists an admin, ops or a closer, even if they own leads or log calls', async () => {
            const own = await makeLead(1, { owner: 'admin' });
            const closerLead = await makeLead(2, { owner: 'closer' });
            await call(own.id, 'admin', true);
            await call(closerLead.id, 'closer', true);
            await call(own.id, 'ops', true);
            const r = await report('manager');
            expect(r.bdas.map((b) => b.name)).toEqual(['BDA Bose', 'BDA Rao']);
            expect(r.kpis.newLeads).toBe(2); // their leads still count in the totals
        });

        it('does not count leads nobody owns in any row, only in the totals', async () => {
            await makeLead(1, { owner: null });
            await makeLead(2, { owner: 'bda1' });
            const r = await report('manager');
            expect(r.kpis.newLeads).toBe(2);
            expect(r.bdas.reduce((n, b) => n + b.leads, 0)).toBe(1);
        });
    });

    describe('what each role sees', () => {
        beforeEach(async () => {
            const a = await makeLead(1, { owner: 'bda1', touchedAfter: 5 * 60_000 });
            const b = await makeLead(2, { owner: 'bda2' });
            await makeOpp(a);
            await makeOpp(b);
            await makeOpp(await makeLead(3, { owner: 'bda2' }), { status: 'LOST', closedAgo: DAY, lostReason: 'Out of TG' });
        });

        it("shows a BDA the same connect rate a manager sees for them, even for calls on someone else's lead", async () => {
            const others = await db.lead.findFirstOrThrow({ where: { ownerId: users.bda2.id } });
            const mine = await db.lead.findFirstOrThrow({ where: { ownerId: users.bda1.id } });
            await call(mine.id, 'bda1', true);
            await call(others.id, 'bda1', false);
            const own = await report('bda1');
            const team = await report('manager');
            expect(own.bdas[0].connectPct).toBe(50);
            expect(team.bdas.find((b) => b.name === 'BDA Bose')!.connectPct).toBe(50);
        });

        it("gives a BDA only their own leads in every figure, and only their own row", async () => {
            const r = await report('bda1');
            expect(r.kpis).toMatchObject({ newLeads: 1, opps: 1, enrolled: 0, contactedPct: 100 });
            expect(r.funnel[0].count).toBe(1);
            expect(r.lost.total).toBe(0);
            expect(r.bdas.map((b) => b.name)).toEqual(['BDA Bose']);
            expect(r.weeks.reduce((n, w) => n + w.values.WORKR, 0)).toBe(1);
        });

        it('gives managers, admins, closers and ops the whole team', async () => {
            for (const key of ['manager', 'admin', 'closer', 'ops']) {
                const r = await report(key);
                expect(r.kpis.newLeads, key).toBe(3);
                expect(r.lost.total, key).toBe(1);
                expect(r.bdas.length, key).toBe(2);
            }
        });

        it('needs a signed-in person', async () => {
            const res = await (await import('supertest')).default(app.getHttpServer()).get('/api/v1/reports/summary');
            expect(res.status).toBe(401);
        });
    });
});
