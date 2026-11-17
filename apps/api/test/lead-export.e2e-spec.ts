/**
 * Date-range filters and CSV export on the leads list, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- lead-export
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

describe.skipIf(!enabled)('Lead date filters and export (real database)', () => {
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


    const at = (iso: string) => new Date(iso);
    async function leadOn(n: number, capturedAt: Date, owner?: string) {
        const lead = await makeLead(n, { owner });
        await db.lead.update({ where: { id: lead.id }, data: { capturedAt } });
        return lead;
    }

    it('filters by the day a lead was captured, in India time, end date included', async () => {
        await leadOn(1, at('2026-11-01T18:29:00Z')); // 31 Oct 23:59 IST
        await leadOn(2, at('2026-11-01T18:31:00Z')); // 2 Nov 00:01 IST
        await leadOn(3, at('2026-11-03T10:00:00Z')); // 3 Nov
        await leadOn(4, at('2026-11-04T18:31:00Z')); // 5 Nov 00:01 IST
        const res = await get('admin', '/leads?from=2026-11-02&to=2026-11-04');
        expect(res.status).toBe(200);
        expect(res.body.leads.map((l: { name: string }) => l.name).sort()).toEqual(['Person 2', 'Person 3']);
        const fromOnly = await get('admin', '/leads?from=2026-11-03');
        expect(fromOnly.body.total).toBe(2);
        const bad = await get('admin', '/leads?from=2026-11-05&to=2026-11-01');
        expect(bad.status).toBe(400);
        expect((await get('admin', '/leads?from=yesterday')).status).toBe(400);
    });

    it('exports the filtered leads as CSV for a manager, and records it', async () => {
        await leadOn(1, at('2026-11-02T10:00:00Z'), 'bda1');
        await leadOn(2, at('2026-11-10T10:00:00Z'));
        const lead = await makeLead(3);
        await db.lead.update({ where: { id: lead.id }, data: { fullName: '=HYPERLINK("http://x")', capturedAt: at('2026-11-02T11:00:00Z') } });
        const res = await get('manager', '/leads/export?from=2026-11-01&to=2026-11-05');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.headers['content-disposition']).toMatch(/attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
        const text = res.text.replace(/^\uFEFF/, '');
        const lines = text.trim().split('\r\n');
        expect(lines[0]).toBe('Name,Phone,Email,Source,Contact stage,Pipeline stage,Heat,Score,Owner,Next step,Next step at,Added');
        expect(lines).toHaveLength(3);
        expect(text).toContain('Person 1');
        expect(text).not.toContain('Person 2');
        expect(text).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
        const audit = await db.auditLog.findFirst({ where: { action: 'lead.exported' } });
        expect(audit).not.toBeNull();
        expect(JSON.stringify(audit?.detail)).not.toContain('Person');
    });

    it('keeps export to managers and admins', async () => {
        await makeLead(1, { owner: 'bda1' });
        for (const key of ['bda1', 'closer', 'ops']) expect((await get(key, '/leads/export')).status).toBe(403);
        expect((await get('admin', '/leads/export')).status).toBe(200);
    });

    const send = async (key: string, method: 'post' | 'delete', path: string, body?: unknown) => {
        const sess = await session(key);
        const req = sess.agent[method](`/api/v1${path}`).set('X-CSRF-Token', sess.csrf);
        return body === undefined ? req : req.send(body as object);
    };

    it('saves, lists and deletes views; shared ones are seen by everyone', async () => {
        const mine = await send('bda1', 'post', '/saved-views', { name: 'Hot Organic', filters: { temperature: 'HOT', from: '2026-11-01' } });
        expect(mine.status).toBe(201);
        expect(mine.body).toMatchObject({ name: 'Hot Organic', shared: false, mine: true, filters: { temperature: 'HOT', from: '2026-11-01' } });

        expect((await send('bda1', 'post', '/saved-views', { name: 'hot organic', filters: {} })).status).toBe(409);
        expect((await send('bda1', 'post', '/saved-views', { name: 'Team', filters: {}, shared: true })).status).toBe(403);
        expect((await send('bda1', 'post', '/saved-views', { name: 'Bad', filters: { temperature: 'LUKEWARM' } })).status).toBe(400);
        expect((await send('bda1', 'post', '/saved-views', { name: 'Extra', filters: { page: 3 } })).status).toBe(400);

        const shared = await send('manager', 'post', '/saved-views', { name: 'Unassigned this week', filters: { view: 'unassigned' }, shared: true });
        expect(shared.status).toBe(201);

        const bdaList = await get('bda1', '/saved-views');
        expect(bdaList.body.views.map((v: { name: string }) => v.name).sort()).toEqual(['Hot Organic', 'Unassigned this week']);
        const other = await get('bda2', '/saved-views');
        expect(other.body.views.map((v: { name: string }) => v.name)).toEqual(['Unassigned this week']);

        expect((await send('bda2', 'delete', `/saved-views/${mine.body.id}`)).status).toBe(403);
        expect((await send('bda1', 'delete', `/saved-views/${shared.body.id}`)).status).toBe(403);
        expect((await send('bda1', 'delete', `/saved-views/${mine.body.id}`)).status).toBe(204);
        expect((await send('admin', 'delete', `/saved-views/${shared.body.id}`)).status).toBe(204);
        expect((await send('admin', 'delete', `/saved-views/${shared.body.id}`)).status).toBe(404);
    });
});
