/**
 * The Assignment page's API against a REAL MySQL/MariaDB database: the waiting queue, the BDAs' loads, the equal
 * round-robin distribution with its cursor, leave days, history and who may use it. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- assignment-queue
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

describe.skipIf(!enabled)('Assignment queue and distribution (real database)', () => {
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
        await db.leadSource.create({ data: { name: 'Meta ads', group: 'META' } });
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
        await db.staffUser.updateMany({ data: { leaveUntil: null } });
    }

    beforeEach(clearLeadData);

    const session = (key: string) => signIn(app, users[key].email, PASSWORD);

    interface Made {
        owner?: string | null;
        depth?: 'NONE' | 'DETAILS' | 'FORM' | 'BOOKED';
        temperature?: 'HOT' | 'WARM' | 'COLD' | null;
        source?: string;
        hoursAgo?: number;
        lifecycle?: 'MARKETING_LEAD' | 'ENGAGED_LEAD' | 'PROSPECT' | 'ENROLLED' | 'NOT_INTERESTED';
        doNotContact?: boolean;
        scheduledCallAt?: Date;
        company?: string;
    }

    async function makeLead(n: number, over: Made = {}) {
        const source = await db.leadSource.findFirstOrThrow({ where: { name: over.source ?? 'WorkR' } });
        const depth = over.depth ?? 'NONE';
        const lead = await db.lead.create({
            data: {
                fullName: `Person ${n}`, email: `p${n}@example.com`, phoneLast10: mobile(n), phoneE164: `+91${mobile(n)}`,
                ownerId: over.owner === undefined || over.owner === null ? null : users[over.owner].id,
                firstSourceId: source.id,
                capturedAt: new Date(Date.now() - (over.hoursAgo ?? 1) * 3_600_000),
                vslDepth: depth,
                temperature: over.temperature ?? null,
                priorityRank: ({ NONE: 0, DETAILS: 1, FORM: 2, BOOKED: 3 }[depth]) * 1000 + ({ COLD: 1, WARM: 2, HOT: 3 }[over.temperature ?? 'COLD'] ?? 0) * (over.temperature ? 100 : 0),
                lifecycleStage: over.lifecycle ?? 'MARKETING_LEAD',
                doNotContact: over.doNotContact ?? false,
                currentCompany: over.company ?? null,
                identities: { create: [{ type: 'EMAIL', value: `p${n}@example.com` }, { type: 'PHONE', value: mobile(n) }] },
            },
        });
        if (over.scheduledCallAt || depth === 'BOOKED') {
            await db.opportunity.create({
                data: { leadId: lead.id, openLeadId: lead.id, stage: 'CALL_1_PENDING', status: 'OPEN', ownerId: null, scheduledCallAt: over.scheduledCallAt ?? new Date(Date.now() + 86_400_000), stageChangedAt: new Date() },
            });
        }
        return lead;
    }

    const get = async (key: string, path: string) => {
        const s = await session(key);
        return s.agent.get(`/api/v1/assignment${path}`);
    };
    const post = async (key: string, path: string, body: unknown) => {
        const s = await session(key);
        return s.agent.post(`/api/v1/assignment${path}`).set('X-CSRF-Token', s.csrf).send(body as object);
    };
    const queue = async (query = '') => {
        const res = await get('manager', `/queue${query}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as {
            items: Array<{ id: string; name: string; depth: string; temperature: string | null; source: string; waitingHours: number; bookedAt: string | null }>;
            matchingIds: string[]; total: number; counts: { all: number; booked: number; hot: number }; sources: Array<{ id: number; name: string }>;
        };
    };

    describe('the queue', () => {
        it('lists only unowned leads still in play, best first: booked, then form, then details, warmer first, longest waiting first', async () => {
            await makeLead(1, { depth: 'NONE', hoursAgo: 40 });
            await makeLead(2, { depth: 'DETAILS', hoursAgo: 5 });
            await makeLead(3, { depth: 'FORM', temperature: 'WARM', hoursAgo: 3 });
            await makeLead(4, { depth: 'FORM', temperature: 'HOT', hoursAgo: 2 });
            await makeLead(5, { depth: 'BOOKED', temperature: 'WARM', hoursAgo: 1 });
            // not waiting for anyone: owned, enrolled, not interested, do-not-contact, merged away
            await makeLead(6, { owner: 'bda1', depth: 'BOOKED' });
            await makeLead(7, { lifecycle: 'ENROLLED' });
            await makeLead(8, { lifecycle: 'NOT_INTERESTED' });
            await makeLead(9, { doNotContact: true });
            const merged = await makeLead(10);
            await db.lead.update({ where: { id: merged.id }, data: { mergedIntoId: (await db.lead.findFirstOrThrow({ select: { id: true } })).id } });

            const q = await queue('?limit=50');
            expect(q.items.map((i) => i.name)).toEqual(['Person 5', 'Person 4', 'Person 3', 'Person 2', 'Person 1']);
            expect(q.items[0]).toMatchObject({ depth: 'BOOKED', temperature: 'WARM', source: 'WorkR' });
            expect(q.items[0]!.bookedAt).not.toBeNull();
            expect(q.items[4]!.waitingHours).toBeGreaterThanOrEqual(39);
            expect(q.total).toBe(5);
            expect(q.counts).toEqual({ all: 5, booked: 1, hot: 1 });
            expect(q.matchingIds).toHaveLength(5);
            expect(q.sources.map((s) => s.name)).toEqual(['WorkR']);
        });

        it('narrows by tab, source, depth, temperature and how long they have waited, while the tab counts stay whole', async () => {
            await makeLead(11, { depth: 'BOOKED', temperature: 'HOT', hoursAgo: 2, source: 'Meta ads' });
            await makeLead(12, { depth: 'FORM', temperature: 'HOT', hoursAgo: 10 });
            await makeLead(13, { depth: 'FORM', temperature: 'COLD', hoursAgo: 30, source: 'Meta ads' });
            await makeLead(14, { depth: 'DETAILS', hoursAgo: 0.5 });

            expect((await queue('?tab=booked')).items.map((i) => i.name)).toEqual(['Person 11']);
            expect((await queue('?tab=hot')).items.map((i) => i.name)).toEqual(['Person 11', 'Person 12']);
            const meta = await db.leadSource.findFirstOrThrow({ where: { name: 'Meta ads' } });
            expect((await queue(`?sourceId=${meta.id}`)).items.map((i) => i.name)).toEqual(['Person 11', 'Person 13']);
            expect((await queue('?depth=FORM')).items.map((i) => i.name)).toEqual(['Person 12', 'Person 13']);
            expect((await queue('?temperature=COLD')).items.map((i) => i.name)).toEqual(['Person 13']);
            expect((await queue('?wait=lt6')).items.map((i) => i.name).sort()).toEqual(['Person 11', 'Person 14']);
            expect((await queue('?wait=6to24')).items.map((i) => i.name)).toEqual(['Person 12']);
            expect((await queue('?wait=gt24')).items.map((i) => i.name)).toEqual(['Person 13']);
            const hot = await queue('?tab=hot');
            expect(hot.counts).toEqual({ all: 4, booked: 1, hot: 2 });
            expect(hot.total).toBe(2);
            expect((await queue('?limit=2')).items).toHaveLength(2);
            expect((await queue('?limit=2')).matchingIds).toHaveLength(4);
            expect((await get('manager', '/queue?tab=nonsense')).status).toBe(400);
        });

        it('reads the booked calls by call date, the furthest-away call first, and hands out the same order', async () => {
            const at = (d: string) => new Date(`${d}T09:00:00Z`);
            await makeLead(21, { depth: 'BOOKED', temperature: 'HOT', hoursAgo: 9, scheduledCallAt: at('2026-10-08') });
            await makeLead(22, { depth: 'BOOKED', temperature: 'HOT', hoursAgo: 8, scheduledCallAt: at('2027-01-29') });
            await makeLead(23, { depth: 'BOOKED', temperature: 'HOT', hoursAgo: 7, scheduledCallAt: at('2026-10-31') });
            await makeLead(24, { depth: 'BOOKED', temperature: 'HOT', hoursAgo: 6, scheduledCallAt: at('2026-10-17') });

            const expected = ['Person 22', 'Person 23', 'Person 24', 'Person 21'];
            const booked = await queue('?tab=booked&limit=50');
            expect(booked.items.map((i) => i.name)).toEqual(expected);
            expect((await queue('?tab=booked&limit=2')).items.map((i) => i.name)).toEqual(expected.slice(0, 2));
            expect((await queue('?depth=BOOKED&limit=50')).items.map((i) => i.name)).toEqual(expected);
            const byName = new Map(booked.items.map((i) => [i.id, i.name]));
            expect(booked.matchingIds.map((id) => byName.get(id))).toEqual(expected);
            expect(booked.total).toBe(4);
        });

        it('gives the sidebar pill the number of waiting leads', async () => {
            await makeLead(15);
            await makeLead(16);
            await makeLead(17, { owner: 'bda1' });
            const res = await get('admin', '/summary');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ waiting: 2 });
        });
    });

    describe('who may use it', () => {
        it('is for admins and sales managers only', async () => {
            for (const key of ['bda1', 'closer', 'ops']) {
                expect((await get(key, '/queue')).status, key).toBe(403);
                expect((await get(key, '/loads')).status, key).toBe(403);
                expect((await get(key, '/history')).status, key).toBe(403);
                expect((await get(key, '/summary')).status, key).toBe(403);
            }
            for (const key of ['admin', 'manager']) expect((await get(key, '/queue')).status, key).toBe(200);
        });

        it('lets an admin give leads to anyone who works leads, and a sales manager only to managers and BDAs, never to an admin', async () => {
            const names = async (key: string) => ((await get(key, '/assignees')).body.assignees as Array<{ name: string }>).map((a) => a.name).sort();
            expect(await names('admin')).toEqual(['Admin Anu', 'BDA Bose', 'BDA Rao', 'BDA Sen', 'Manager Mira']);
            expect(await names('manager')).toEqual(['BDA Bose', 'BDA Rao', 'BDA Sen', 'Manager Mira']);

            const lead = await makeLead(60);
            const ownerOf = async () => (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId;
            const toAdmin = await post('manager', '/bulk', { leadIds: [lead.publicId], toUserId: users.admin.publicId });
            expect(toAdmin.status).toBe(400);
            expect(toAdmin.body).toMatchObject({ code: 'ASSIGNEE_INVALID', fields: { toUserId: 'Choose an active sales manager or BDA' } });
            expect(await ownerOf()).toBeNull();

            const toManager = await post('manager', '/bulk', { leadIds: [lead.publicId], toUserId: users.manager.publicId });
            expect(toManager.status, JSON.stringify(toManager.body)).toBeLessThan(300);
            expect(await ownerOf()).toBe(users.manager.id);
            const toAdminByAdmin = await post('admin', '/bulk', { leadIds: [lead.publicId], toUserId: users.admin.publicId });
            expect(toAdminByAdmin.status, JSON.stringify(toAdminByAdmin.body)).toBeLessThan(300);
            expect(await ownerOf()).toBe(users.admin.id);
        });
    });

    describe('the people leads are shared between', () => {
        it('shows each BDA and sales manager with the leads they hold, the hot leads they were given this week, and who is away', async () => {
            await makeLead(20, { owner: 'bda1' });
            await makeLead(21, { owner: 'bda1' });
            await makeLead(22, { owner: 'bda2', lifecycle: 'ENROLLED' });
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
            const lead = await db.lead.findFirstOrThrow({ where: { fullName: 'Person 20' } });
            await db.leadAssignment.create({ data: { leadId: lead.id, toUserId: users.bda1.id, byUserId: users.manager.id, method: 'BULK', batchId: '11111111-1111-4111-8111-111111111111', sourceId: source.id, vslDepth: 'FORM', temperature: 'HOT' } });
            await db.leadAssignment.create({ data: { leadId: lead.id, toUserId: users.bda1.id, byUserId: users.manager.id, method: 'BULK', batchId: '11111111-1111-4111-8111-111111111112', sourceId: source.id, vslDepth: 'FORM', temperature: 'HOT', createdAt: new Date(Date.now() - 20 * 86_400_000) } });

            const leave = await post('manager', '/leave', { userId: users.bda3.publicId, until: new Date(Date.now() + 3 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10) });
            expect(leave.status, JSON.stringify(leave.body)).toBe(200);

            const res = await get('manager', '/loads');
            expect(res.status).toBe(200);
            const by = Object.fromEntries((res.body.bdas as Array<{ name: string; role: string; open: number; hotReceived: number; leaveUntil: string | null }>).map((b) => [b.name, b]));
            expect(Object.keys(by).sort()).toEqual(['BDA Bose', 'BDA Rao', 'BDA Sen', 'Manager Mira']);
            expect(by['Manager Mira']).toMatchObject({ role: 'SALES_MANAGER', open: 0 });
            expect(by['BDA Rao']!.role).toBe('BDA');
            expect(by['BDA Bose']).toMatchObject({ open: 2, hotReceived: 1, leaveUntil: null });
            expect(by['BDA Rao']).toMatchObject({ open: 0, hotReceived: 0 });
            expect(by['BDA Sen']!.leaveUntil).not.toBeNull();
            expect(res.body.cursorUserId).toBeNull();
        });

        it('sets and clears leave, for a BDA or a sales manager, and refuses a past day, an admin, a closer or an unknown person', async () => {
            const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
            expect((await post('manager', '/leave', { userId: users.bda1.publicId, until: today })).status).toBe(200);
            expect(((await get('manager', '/loads')).body.bdas as Array<{ name: string; leaveUntil: string | null }>).find((b) => b.name === 'BDA Bose')!.leaveUntil).toBe(today);
            expect((await post('manager', '/leave', { userId: users.bda1.publicId, until: null })).status).toBe(200);
            expect(((await get('manager', '/loads')).body.bdas as Array<{ name: string; leaveUntil: string | null }>).find((b) => b.name === 'BDA Bose')!.leaveUntil).toBeNull();
            const past = await post('manager', '/leave', { userId: users.bda1.publicId, until: '2020-01-01' });
            expect(past.status).toBe(400);
            expect(past.body.code).toBe('LEAVE_IN_PAST');
            expect((await post('manager', '/leave', { userId: users.manager.publicId, until: today })).status).toBe(200);
            expect((await post('manager', '/leave', { userId: users.manager.publicId, until: null })).status).toBe(200);
            for (const key of ['admin', 'closer']) expect((await post('manager', '/leave', { userId: users[key]!.publicId, until: today })).status, key).toBe(400);
            expect((await post('manager', '/leave', { userId: '00000000-0000-4000-8000-000000000000', until: today })).status).toBe(400);
            expect((await post('bda1', '/leave', { userId: users.bda1.publicId, until: today })).status).toBe(403);
        });
    });

    describe('equal distribution', () => {
        const ids = async (...names: string[]) => (await db.lead.findMany({ where: { fullName: { in: names } } })).map((l) => l.publicId);
        const ownerOf = async (name: string) => (await db.lead.findFirstOrThrow({ where: { fullName: name } })).ownerId;

        it('shares the leads one after another, best first, and carries on from the last person next time', async () => {
            await makeLead(30, { depth: 'BOOKED', temperature: 'HOT' });
            await makeLead(31, { depth: 'FORM', temperature: 'WARM' });
            await makeLead(32, { depth: 'DETAILS' });
            await makeLead(33, { depth: 'NONE' });
            await makeLead(34, { depth: 'NONE' });
            const people = [users.bda1.publicId, users.bda2.publicId, users.bda3.publicId];

            const first = await post('manager', '/distribute', { leadIds: await ids('Person 30', 'Person 31', 'Person 32', 'Person 33'), toUserIds: people });
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            expect(first.body).toMatchObject({ assigned: 4, skipped: 0 });
            expect(first.body.perPerson.map((p: { name: string; count: number }) => [p.name, p.count])).toEqual([['BDA Bose', 2], ['BDA Rao', 1], ['BDA Sen', 1]]);
            expect(await ownerOf('Person 30')).toBe(users.bda1.id);
            expect(await ownerOf('Person 31')).toBe(users.bda2.id);
            expect(await ownerOf('Person 32')).toBe(users.bda3.id);
            expect(await ownerOf('Person 33')).toBe(users.bda1.id);

            // the last lead went to Bose, so the next batch starts with Rao
            expect((await get('manager', '/loads')).body.cursorUserId).toBe(users.bda1.publicId);
            const second = await post('manager', '/distribute', { leadIds: await ids('Person 34'), toUserIds: people });
            expect(second.body).toMatchObject({ assigned: 1 });
            expect(await ownerOf('Person 34')).toBe(users.bda2.id);
            expect((await get('manager', '/loads')).body.cursorUserId).toBe(users.bda2.publicId);
        });

        it('takes the leads out of the queue, gives the new owners their opportunities, tasks and an alert, and logs one batch', async () => {
            const lead = await makeLead(35, { depth: 'BOOKED', temperature: 'HOT' });
            await db.task.create({ data: { leadId: lead.id, assigneeId: null, type: 'SCHEDULED_CALL', title: 'Counselling call', dueAt: new Date(Date.now() + 3_600_000), bookingRef: 'bk-35' } });
            await makeLead(36);
            const res = await post('manager', '/distribute', { leadIds: await ids('Person 35', 'Person 36'), toUserIds: [users.bda1.publicId, users.bda2.publicId] });
            expect(res.status, JSON.stringify(res.body)).toBe(200);

            expect((await queue()).total).toBe(0);
            expect((await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id } })).ownerId).toBe(users.bda1.id);
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).assigneeId).toBe(users.bda1.id);
            expect(await db.notification.count({ where: { userId: users.bda1.id, type: 'NEW_ASSIGNMENT' } })).toBe(1);
            expect(await db.notification.count({ where: { userId: users.bda2.id, type: 'NEW_ASSIGNMENT' } })).toBe(1);
            const log = await db.leadAssignment.findMany({ where: { method: 'EQUAL_DISTRIBUTION' } });
            expect(log).toHaveLength(2);
            expect(new Set(log.map((l) => l.batchId)).size).toBe(1);
            expect(log.every((l) => l.byUserId === users.manager.id)).toBe(true);
            expect(log.find((l) => l.leadId === lead.id)).toMatchObject({ vslDepth: 'BOOKED', temperature: 'HOT', toUserId: users.bda1.id });
        });

        it('leaves a lead that already has an owner alone and says so', async () => {
            await makeLead(37);
            await makeLead(38, { owner: 'bda3' });
            const res = await post('manager', '/distribute', { leadIds: [...(await ids('Person 37', 'Person 38')), '99999999-9999-4999-8999-999999999999'], toUserIds: [users.bda1.publicId] });
            expect(res.body).toMatchObject({ assigned: 1, skipped: 2 });
            expect(await ownerOf('Person 38')).toBe(users.bda3.id);
            const again = await post('manager', '/distribute', { leadIds: await ids('Person 37'), toUserIds: [users.bda2.publicId] });
            expect(again.body).toMatchObject({ assigned: 0, skipped: 1, perPerson: [] });
            expect(await ownerOf('Person 37')).toBe(users.bda1.id);
        });

        it('can include sales managers in the round robin, so an admin with no BDAs can still share leads', async () => {
            await makeLead(45);
            await makeLead(46);
            const res = await post('admin', '/distribute', { leadIds: await ids('Person 45', 'Person 46'), toUserIds: [users.manager.publicId, users.bda1.publicId] });
            expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
            expect(res.body.assigned).toBe(2);
            expect([await ownerOf('Person 45'), await ownerOf('Person 46')].sort()).toEqual([users.manager.id, users.bda1.id].sort());
        });

        it('refuses a person on leave, an admin, a closer, an unknown person and an empty choice', async () => {
            await makeLead(39);
            const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
            await post('manager', '/leave', { userId: users.bda2.publicId, until: today });
            const away = await post('manager', '/distribute', { leadIds: await ids('Person 39'), toUserIds: [users.bda1.publicId, users.bda2.publicId] });
            expect(away.status).toBe(400);
            expect(away.body.code).toBe('ASSIGNEE_ON_LEAVE');
            for (const key of ['admin', 'closer']) expect((await post('manager', '/distribute', { leadIds: await ids('Person 39'), toUserIds: [users[key]!.publicId] })).status, key).toBe(400);
            expect((await post('manager', '/distribute', { leadIds: await ids('Person 39'), toUserIds: [] })).status).toBe(400);
            expect((await post('manager', '/distribute', { leadIds: [], toUserIds: [users.bda1.publicId] })).status).toBe(400);
            expect((await post('bda1', '/distribute', { leadIds: await ids('Person 39'), toUserIds: [users.bda1.publicId] })).status).toBe(403);
            expect(await ownerOf('Person 39')).toBeNull();
        });

        it('keeps a history of distributions and bulk assignments: when, who, how many, to whom', async () => {
            await makeLead(40);
            await makeLead(41);
            await makeLead(42);
            await post('manager', '/distribute', { leadIds: await ids('Person 40', 'Person 41'), toUserIds: [users.bda1.publicId, users.bda2.publicId] });
            await post('admin', '/bulk', { leadIds: await ids('Person 42'), toUserId: users.bda3.publicId });
            const res = await get('manager', '/history');
            expect(res.status).toBe(200);
            const history = res.body.history as Array<{ by: string; count: number; method: string; people: string[] }>;
            expect(history).toHaveLength(2);
            expect(history[0]).toMatchObject({ by: 'Admin Anu', count: 1, method: 'BULK', people: ['BDA Sen'] });
            expect(history[1]).toMatchObject({ by: 'Manager Mira', count: 2, method: 'EQUAL_DISTRIBUTION' });
            expect([...history[1]!.people].sort()).toEqual(['BDA Bose', 'BDA Rao']);
        });
    });
});
