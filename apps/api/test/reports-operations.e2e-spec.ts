/**
 * The operations reports, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- reports-operations
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

describe.skipIf(!enabled)('Operations reports (real database)', () => {
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

    const get = async (key: string, path: string) => (await session(key)).agent.get(`/api/v1${path}`);

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




    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

    /** A lead that arrived `arrived` minutes ago and was first touched `waited` minutes after (null = not yet). */
    async function leadWith(n: number, owner: string, arrived: number, waited: number | null) {
        const lead = await makeLead(n, { owner });
        await db.lead.update({
            where: { id: lead.id },
            data: { capturedAt: minutesAgo(arrived), firstTouchAt: waited === null ? null : new Date(minutesAgo(arrived).getTime() + waited * 60_000) },
        });
        return lead;
    }

    it('measures first response against the target', async () => {
        await leadWith(1, 'bda1', 600, 5);
        await leadWith(2, 'bda1', 600, 30);
        await leadWith(3, 'bda1', 600, 300);
        await leadWith(4, 'bda2', 600, null);
        await leadWith(5, 'bda2', 10, null); // too new to judge

        const res = await get('manager', '/reports/operations?days=30');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const fr = res.body.firstResponse;
        expect(fr).toMatchObject({ targetMinutes: 60, leads: 5, judged: 4, withinTarget: 2, pct: 50, waiting: 1, medianMinutes: 30 });
        expect(fr.buckets.map((b: { key: string; count: number }) => [b.key, b.count])).toEqual([
            ['within15m', 1], ['within1h', 1], ['within4h', 0], ['within24h', 1], ['later', 0], ['none', 2],
        ]);

        await send('admin', 'patch', '/admin/settings', { 'reports.firstResponseTargetMinutes': 10 });
        const strict = (await get('manager', '/reports/operations?days=30')).body.firstResponse;
        expect(strict).toMatchObject({ targetMinutes: 10, withinTarget: 1, judged: 5, waiting: 2 });

        // A BDA only sees their own leads, and gets no fairness table.
        const mine = await get('bda1', '/reports/operations?days=30');
        expect(mine.body.firstResponse.leads).toBe(3);
        expect(mine.body.fairness).toBeNull();
    });

    it('shows how long open opportunities sit in each stage', async () => {
        const a = await makeLead(1, { owner: 'bda1' });
        const b = await makeLead(2, { owner: 'bda2' });
        const c = await makeLead(3, { owner: 'bda2' });
        const day = (d: number) => new Date(Date.now() - d * 86_400_000);
        await db.opportunity.updateMany({ where: { leadId: a.id }, data: { stage: 'CALL_2', stageChangedAt: day(12) } });
        await db.opportunity.updateMany({ where: { leadId: b.id }, data: { stage: 'CALL_2', stageChangedAt: day(2) } });
        await db.opportunity.updateMany({ where: { leadId: c.id }, data: { stage: 'TEST', stageChangedAt: day(20) } });

        const res = await get('manager', '/reports/operations');
        const call2 = res.body.stageAging.stages.find((s: { stage: string }) => s.stage === 'CALL_2');
        expect(call2).toMatchObject({ open: 2, stale: 1, maxDays: 12 });
        expect(call2.avgDays).toBeGreaterThan(6.9);
        expect(call2.avgDays).toBeLessThan(7.1);
        expect(res.body.stageAging.staleDays).toBe(7);
        expect(res.body.stageAging.longest.map((l: { leadId: string; days: number }) => [l.leadId, l.days])).toEqual([[c.publicId, 20], [a.publicId, 12], [b.publicId, 2]]);
        expect(res.body.stageAging.stages.some((s: { stage: string }) => s.stage === 'CLOSED_WON')).toBe(false);

        await send('admin', 'patch', '/admin/settings', { 'reports.stageStaleDays': 1 });
        expect((await get('manager', '/reports/operations')).body.stageAging.stages.find((s: { stage: string }) => s.stage === 'CALL_2').stale).toBe(2);
        expect((await get('bda2', '/reports/operations')).body.stageAging.longest.map((l: { leadId: string }) => l.leadId)).toEqual([c.publicId, b.publicId]);
    });

    it('compares how many leads each BDA was handed', async () => {
        const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        const lead = await makeLead(1, {});
        const give = async (to: string, count: number, hot = 0) => {
            for (let i = 0; i < count; i++) {
                await db.leadAssignment.create({
                    data: { leadId: lead.id, toUserId: users[to].id, method: 'EQUAL_DISTRIBUTION', sourceId: source.id, vslDepth: i < 2 ? 'FORM' : 'NONE', temperature: i < hot ? 'HOT' : 'COLD' },
                });
            }
        };
        await give('bda1', 14, 7);
        await give('bda2', 6, 0);
        // bda3 got nothing.
        const res = await get('manager', '/reports/operations?days=30');
        const f = res.body.fairness;
        expect(f).toMatchObject({ total: 20, expectedEach: 6.7, judgeable: true });
        const by = Object.fromEntries(f.people.map((p: { name: string }) => [p.name, p]));
        expect(by['BDA Bose']).toMatchObject({ assigned: 14, sharePct: 70, hotPct: 50, flag: 'over' });
        expect(by['BDA Rao']).toMatchObject({ assigned: 6, flag: null });
        expect(by['BDA Sen']).toMatchObject({ assigned: 0, flag: 'under', hotPct: null });
        expect(f.people[0].name).toBe('BDA Bose');

        await db.leadAssignment.deleteMany({});
        const none = (await get('manager', '/reports/operations?days=30')).body.fairness;
        expect(none).toMatchObject({ total: 0, judgeable: false });
        expect(none.people.every((p: { flag: string | null }) => p.flag === null)).toBe(true);
        expect((await get('ops', '/reports/operations')).status).toBe(200);
    });
});
