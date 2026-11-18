/**
 * The pipeline board against a REAL MySQL/MariaDB database: open opportunities by stage, what was won this month,
 * the win rate, the filters, and what each role may see. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- pipeline-board
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
import { startOfIstMonth } from '../src/modules/pipeline/ist.js';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('Pipeline board (real database)', () => {
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
        await db.lostReason.create({ data: { name: 'Out of TG' } });
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
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

    type Stage = 'CALL_1_PENDING' | 'CALL_1' | 'TEST' | 'CALL_2' | 'PSYCHOMETRIC_SESSION' | 'DECISION_OBJECTION' | 'PAYMENT_FINANCING';
    interface Made {
        owner?: string | null;
        stage?: Stage;
        temperature?: 'HOT' | 'WARM' | 'COLD' | null;
        /** 'WON' and 'LOST' close the opportunity `closedAgoDays` days ago. */
        status?: 'OPEN' | 'WON' | 'LOST';
        closedAgoDays?: number;
        movedHoursAgo?: number;
        company?: string;
        scheduledCallAt?: Date;
        nextFollowupAt?: Date;
        merged?: boolean;
    }

    async function makeLead(n: number, over: Made = {}) {
        const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        const ownerId = over.owner === null ? null : users[over.owner ?? 'bda1'].id;
        const status = over.status ?? 'OPEN';
        const lead = await db.lead.create({
            data: {
                fullName: `Person ${n}`, email: `p${n}@example.com`, phoneLast10: mobile(n), phoneE164: `+91${mobile(n)}`,
                ownerId, firstSourceId: source.id, capturedAt: new Date(), temperature: over.temperature ?? null,
                currentCompany: over.company ?? null, nextFollowupAt: over.nextFollowupAt ?? null,
                lifecycleStage: status === 'WON' ? 'ENROLLED' : 'PROSPECT',
                mergedIntoId: over.merged ? (await db.lead.findFirstOrThrow({ select: { id: true } })).id : null,
                identities: { create: [{ type: 'EMAIL', value: `p${n}@example.com` }, { type: 'PHONE', value: mobile(n) }] },
            },
        });
        const closedAt = status === 'OPEN' ? null : new Date(Date.now() - (over.closedAgoDays ?? 1) * 86_400_000);
        await db.opportunity.create({
            data: {
                leadId: lead.id,
                openLeadId: status === 'OPEN' ? lead.id : null,
                stage: status === 'WON' ? 'CLOSED_WON' : (over.stage ?? 'CALL_1_PENDING'),
                status,
                ownerId,
                closedAt,
                scheduledCallAt: over.scheduledCallAt ?? null,
                stageChangedAt: closedAt ?? new Date(Date.now() - (over.movedHoursAgo ?? 1) * 3_600_000),
                ...(status === 'LOST' ? { lostReasonId: (await db.lostReason.findFirstOrThrow()).id } : {}),
            },
        });
        return lead;
    }

    const board = async (key: string, query = '') => {
        const s = await session(key);
        const res = await s.agent.get(`/api/v1/pipeline${query}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as {
            columns: Array<{ stage: string; count: number; cards: Array<Record<string, any>> }>;
            open: number;
            wonThisMonth: number;
            lostThisMonth: number;
            winRate: number | null;
            owners: Array<{ id: string; name: string }>;
        };
    };
    const column = (b: Awaited<ReturnType<typeof board>>, stage: string) => b.columns.find((c) => c.stage === stage)!;

    it('lists every stage in order with its count, newest move first, and cards that carry no internal ids', async () => {
        await makeLead(1, { stage: 'CALL_1_PENDING', movedHoursAgo: 5, temperature: 'HOT', company: 'Acme' });
        await makeLead(2, { stage: 'CALL_1_PENDING', movedHoursAgo: 1 });
        await makeLead(3, { stage: 'TEST' });
        await makeLead(4, { stage: 'PAYMENT_FINANCING' });

        const b = await board('manager');
        expect(b.columns.map((c) => c.stage)).toEqual([
            'CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_2', 'PSYCHOMETRIC_SESSION', 'DECISION_OBJECTION', 'PAYMENT_FINANCING', 'CLOSED_WON',
        ]);
        expect(b.columns.map((c) => c.count)).toEqual([2, 0, 1, 0, 0, 0, 1, 0]);
        expect(b.open).toBe(4);
        const first = column(b, 'CALL_1_PENDING');
        expect(first.cards.map((c) => c.name)).toEqual(['Person 2', 'Person 1']);
        expect(first.cards[1]).toMatchObject({
            name: 'Person 1', company: 'Acme', temperature: 'HOT', source: 'WorkR',
            owner: { id: users.bda1.publicId, name: 'BDA Bose' }, next: { kind: 'none', at: null },
        });
        expect(Object.keys(first.cards[1]).sort()).toEqual(['company', 'domain', 'id', 'name', 'next', 'owner', 'source', 'stageChangedAt', 'stageOn', 'temperature']);
        expect(JSON.stringify(b)).not.toMatch(/"(id|leadId|ownerId)":\d/);
    });

    it('sends only as many cards as asked for, while the counts cover everything', async () => {
        for (let i = 1; i <= 5; i++) await makeLead(i, { movedHoursAgo: i });
        const b = await board('manager', '?perColumn=2');
        const col = column(b, 'CALL_1_PENDING');
        expect(col.count).toBe(5);
        expect(col.cards.map((c) => c.name)).toEqual(['Person 1', 'Person 2']);
        expect(b.open).toBe(5);
    });

    it('shows a booked call before a follow-up, and a follow-up when there is no call', async () => {
        const call = hours(3);
        const followUp = hours(30);
        await makeLead(1, { scheduledCallAt: call, nextFollowupAt: followUp });
        await makeLead(2, { nextFollowupAt: followUp, movedHoursAgo: 2 });
        const cards = column(await board('manager'), 'CALL_1_PENDING').cards;
        expect(cards.find((c) => c.name === 'Person 1')!.next).toEqual({ kind: 'booked', at: call.toISOString() });
        expect(cards.find((c) => c.name === 'Person 2')!.next).toEqual({ kind: 'task', at: followUp.toISOString() });
    });

    describe('what each role sees', () => {
        beforeEach(async () => {
            await makeLead(1, { owner: 'bda1', stage: 'CALL_1' });
            await makeLead(2, { owner: 'bda1', stage: 'TEST' });
            await makeLead(3, { owner: 'bda2', stage: 'CALL_1' });
            await makeLead(4, { owner: null, stage: 'CALL_1' });
            await makeLead(5, { owner: 'bda1', status: 'WON', closedAgoDays: 1 });
            await makeLead(6, { owner: 'bda2', status: 'WON', closedAgoDays: 1 });
        });

        it('shows a BDA only their own leads, with no owner list', async () => {
            const b = await board('bda1');
            expect(b.columns.map((c) => c.count)).toEqual([0, 1, 1, 0, 0, 0, 0, 1]);
            expect(b.columns.flatMap((c) => c.cards.map((x) => x.name)).sort()).toEqual(['Person 1', 'Person 2', 'Person 5']);
            expect(b.owners).toEqual([]);
        });

        it('shows managers, admins and ops the whole team, with the owners to filter by', async () => {
            for (const key of ['manager', 'admin', 'ops']) {
                const b = await board(key);
                expect(b.open, key).toBe(4);
                expect(b.wonThisMonth, key).toBe(2);
                expect(b.owners.map((o) => o.name), key).toEqual(['BDA Bose', 'BDA Rao']);
            }
        });

        it("gives a closer the team's numbers but only the leads in play as cards", async () => {
            const b = await board('closer');
            expect(b.open).toBe(4);
            expect(column(b, 'CLOSED_WON').count).toBe(2);
            expect(column(b, 'CLOSED_WON').cards).toEqual([]);
            expect(column(b, 'CALL_1').cards).toHaveLength(3);
        });

        it('leaves out leads that were merged into another', async () => {
            await makeLead(7, { owner: 'bda1', stage: 'CALL_1', merged: true });
            expect(column(await board('manager'), 'CALL_1').count).toBe(3);
        });
    });

    describe('filters', () => {
        beforeEach(async () => {
            await makeLead(1, { owner: 'bda1', temperature: 'HOT' });
            await makeLead(2, { owner: 'bda1', temperature: 'COLD' });
            await makeLead(3, { owner: 'bda2', temperature: 'HOT' });
            await makeLead(4, { owner: null, temperature: 'HOT' });
        });

        it('narrows by temperature', async () => {
            const b = await board('manager', '?temperature=HOT');
            expect(b.open).toBe(3);
            expect(column(b, 'CALL_1_PENDING').cards.map((c) => c.temperature)).toEqual(['HOT', 'HOT', 'HOT']);
        });

        it('narrows by owner, or to leads nobody owns', async () => {
            expect((await board('manager', `?ownerId=${users.bda1.publicId}`)).open).toBe(2);
            const unowned = await board('manager', '?ownerId=none');
            expect(unowned.open).toBe(1);
            expect(column(unowned, 'CALL_1_PENDING').cards[0].owner).toBeNull();
        });

        it('combines filters, and cannot be used by a BDA to see someone else', async () => {
            expect((await board('manager', `?temperature=HOT&ownerId=${users.bda1.publicId}`)).open).toBe(1);
            expect((await board('bda1', `?ownerId=${users.bda2.publicId}`)).open).toBe(0);
        });

        it('rejects an unknown temperature or owner', async () => {
            const s = await session('manager');
            expect((await s.agent.get('/api/v1/pipeline?temperature=LUKEWARM')).status).toBe(400);
            expect((await s.agent.get('/api/v1/pipeline?ownerId=abc')).status).toBe(400);
            expect((await s.agent.get('/api/v1/pipeline?perColumn=0')).status).toBe(400);
        });
    });

    describe('won, lost and the win rate', () => {
        it('counts this month\'s wins in Closed Won, leaves out older ones, and never shows lost opportunities', async () => {
            const sinceMonth = Math.floor((Date.now() - startOfIstMonth(new Date()).getTime()) / 86_400_000);
            await makeLead(1, { status: 'WON', closedAgoDays: 0 });
            await makeLead(2, { status: 'WON', closedAgoDays: sinceMonth + 3 });
            await makeLead(3, { status: 'LOST', closedAgoDays: 0, stage: 'TEST' });
            await makeLead(4, { stage: 'TEST' });
            const b = await board('manager');
            expect(column(b, 'CLOSED_WON').count).toBe(1);
            expect(column(b, 'CLOSED_WON').cards.map((c) => c.name)).toEqual(['Person 1']);
            expect(column(b, 'TEST').count).toBe(1);
            expect(b.open).toBe(1);
            expect(b.wonThisMonth).toBe(1);
            expect(b.lostThisMonth).toBe(1);
        });

        it('works the win rate out as won over won plus lost this month, and says nothing when none closed', async () => {
            expect((await board('manager')).winRate).toBeNull();
            await makeLead(1, { status: 'WON', closedAgoDays: 0 });
            await makeLead(2, { status: 'LOST', closedAgoDays: 0 });
            await makeLead(3, { status: 'LOST', closedAgoDays: 0 });
            await makeLead(4, { status: 'LOST', closedAgoDays: 0 });
            expect((await board('manager')).winRate).toBeCloseTo(25, 5);
        });

        it('gives a BDA their own win rate', async () => {
            await makeLead(1, { owner: 'bda1', status: 'WON', closedAgoDays: 0 });
            await makeLead(2, { owner: 'bda1', status: 'LOST', closedAgoDays: 0 });
            await makeLead(3, { owner: 'bda2', status: 'LOST', closedAgoDays: 0 });
            await makeLead(4, { owner: 'bda2', status: 'LOST', closedAgoDays: 0 });
            expect((await board('bda1')).winRate).toBeCloseTo(50, 5);
            expect((await board('manager')).winRate).toBeCloseTo(25, 5);
        });
    });

    describe('moving a card', () => {
        const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
        const move = (s: Awaited<ReturnType<typeof session>>, lead: { publicId: string }, stage: string, date: string | null = today) =>
            s.agent.post(`/api/v1/leads/${lead.publicId}/opportunity/stage`).set('X-CSRF-Token', s.csrf).send({ stage, ...(date ? { date } : {}) });
        const day = (offset: number) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);

        describe('the day a stage needs', () => {
            it('asks for the test date, and keeps it', async () => {
                const lead = await makeLead(1, { owner: 'bda1', stage: 'CALL_1' });
                const bda = await session('bda1');
                const none = await move(bda, lead, 'TEST', null);
                expect(none.status).toBe(400);
                expect(none.body).toMatchObject({ code: 'STAGE_DATE_INVALID', fields: { date: 'Choose the test date' } });
                expect((await move(bda, lead, 'TEST', day(-61))).status).toBe(400);
                expect((await move(bda, lead, 'TEST', day(366))).status).toBe(400);
                expect(await db.opportunity.count({ where: { leadId: lead.id, stage: 'TEST' } })).toBe(0);

                const res = await move(bda, lead, 'TEST', day(3));
                expect(res.status, JSON.stringify(res.body)).toBe(200);
                expect(res.body.opportunity).toMatchObject({ stage: 'TEST', testOn: day(3), psychometricOn: null, wonOn: null });
                expect(res.body.events[0].title).toMatch(/^Moved to Test for \d{1,2} [A-Z][a-z]{2} \d{4}$/);
                expect(await board('bda1').then((b) => column(b, 'TEST').cards[0]!.stageOn)).toBe(day(3));
            });

            it('asks for the psychometric session date', async () => {
                const lead = await makeLead(2, { owner: 'bda1', stage: 'CALL_2' });
                const bda = await session('bda1');
                const none = await move(bda, lead, 'PSYCHOMETRIC_SESSION', null);
                expect(none.body.fields.date).toBe('Choose the date of the psychometric session');
                const res = await move(bda, lead, 'PSYCHOMETRIC_SESSION', day(7));
                expect(res.body.opportunity).toMatchObject({ stage: 'PSYCHOMETRIC_SESSION', psychometricOn: day(7) });
            });

            it('moves the date when the lead is sent to the same stage again, without a second stage change', async () => {
                const lead = await makeLead(3, { owner: 'bda1', stage: 'CALL_1' });
                const bda = await session('bda1');
                await move(bda, lead, 'TEST', day(2));
                const before = await db.opportunityStageChange.count({ where: { opportunity: { leadId: lead.id } } });
                const res = await move(bda, lead, 'TEST', day(5));
                expect(res.status).toBe(200);
                expect(res.body.opportunity.testOn).toBe(day(5));
                expect(res.body.events[0]).toMatchObject({ type: 'OPPORTUNITY_STAGE_CHANGED', sub: expect.stringContaining('Rescheduled') });
                expect(await db.opportunityStageChange.count({ where: { opportunity: { leadId: lead.id } } })).toBe(before);
                // Sending it to the same stage with no date changes nothing.
                expect((await move(bda, lead, 'TEST', null)).body.opportunity.testOn).toBe(day(5));
            });

            it('asks for the day a deal was won, never in the future, and shows it on the board', async () => {
                const lead = await makeLead(4, { owner: 'bda1', stage: 'PAYMENT_FINANCING' });
                const mgr = await session('manager');
                expect((await move(mgr, lead, 'CLOSED_WON', null)).body.fields.date).toBe('Choose the date it was won');
                expect((await move(mgr, lead, 'CLOSED_WON', day(1))).body.fields.date).toBe('The date it was won cannot be in the future');
                const res = await move(mgr, lead, 'CLOSED_WON', day(-2));
                expect(res.status, JSON.stringify(res.body)).toBe(200);
                expect(res.body.opportunity).toMatchObject({ stage: 'CLOSED_WON', status: 'WON', wonOn: day(-2) });
                expect(res.body.events.find((e: { type: string }) => e.type === 'OPPORTUNITY_WON').title).toMatch(/^Opportunity won on /);
                expect((await board('manager').then((b) => column(b, 'CLOSED_WON').cards[0]!)).stageOn).toBe(day(-2));
            });

            it('does not ask for a day when moving to the other stages', async () => {
                const lead = await makeLead(5, { owner: 'bda1', stage: 'CALL_1' });
                const res = await move(await session('bda1'), lead, 'CALL_2', null);
                expect(res.status).toBe(200);
                expect(res.body.opportunity).toMatchObject({ stage: 'CALL_2', testOn: null });
            });
        });

        it('puts a card in its new column, on top, after a move', async () => {
            const lead = await makeLead(1, { owner: 'bda1', stage: 'CALL_1', movedHoursAgo: 48 });
            await makeLead(2, { owner: 'bda1', stage: 'TEST', movedHoursAgo: 1 });
            const s = await session('bda1');
            expect((await move(s, lead, 'TEST')).status).toBe(200);
            const b = await board('bda1');
            expect(column(b, 'CALL_1').count).toBe(0);
            expect(column(b, 'TEST').cards.map((c) => c.name)).toEqual(['Person 1', 'Person 2']);
        });

        it('shows a won lead in Closed Won after a manager closes it, and refuses a BDA', async () => {
            const lead = await makeLead(1, { owner: 'bda1', stage: 'PAYMENT_FINANCING' });
            const bda = await session('bda1');
            expect((await move(bda, lead, 'CLOSED_WON')).status).toBe(403);
            const mgr = await session('manager');
            expect((await move(mgr, lead, 'CLOSED_WON')).status).toBe(200);
            const b = await board('manager');
            expect(column(b, 'PAYMENT_FINANCING').count).toBe(0);
            expect(column(b, 'CLOSED_WON').cards.map((c) => c.name)).toEqual(['Person 1']);
            expect(b.winRate).toBe(100);
        });
    });

    it('needs a signed-in person', async () => {
        const res = await (await import('supertest')).default(app.getHttpServer()).get('/api/v1/pipeline');
        expect(res.status).toBe(401);
    });
});
