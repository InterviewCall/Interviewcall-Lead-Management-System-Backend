/**
 * The audit log viewer and the settings, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- audit-settings
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

describe.skipIf(!enabled)('Audit log and settings (real database)', () => {
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




    it('shows the audit log to admins only, newest first, with filters', async () => {
        const lead = await makeLead(1, { owner: 'bda1' });
        await send('bda1', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: true, reason: 'Asked to stop' });
        await send('manager', 'post', `/leads/${lead.publicId}/do-not-contact`, { value: false });
        expect((await get('manager', '/admin/audit')).status).toBe(403);
        expect((await get('bda1', '/admin/audit')).status).toBe(403);

        const all = await get('admin', '/admin/audit');
        expect(all.status, JSON.stringify(all.body)).toBe(200);
        const dnc = all.body.entries.filter((e: { action: string }) => e.action.startsWith('lead.dnc'));
        expect(dnc.map((e: { action: string }) => e.action)).toEqual(['lead.dnc_cleared', 'lead.dnc_set']);
        expect(dnc[1]).toMatchObject({ entityType: 'lead', entityId: lead.publicId, detail: { reason: 'Asked to stop' }, actor: { name: 'BDA Bose' } });

        const family = await get('admin', '/admin/audit?action=lead.dnc_');
        expect(family.body.total).toBe(0);
        expect((await get('admin', '/admin/audit?action=lead.')).body.total).toBeGreaterThanOrEqual(2);
        expect((await get('admin', '/admin/audit?action=lead.dnc_set')).body.total).toBe(1);
        expect((await get('admin', `/admin/audit?actorId=${users.manager.publicId}`)).body.entries.every((e: { actor: { name: string } }) => e.actor.name === 'Manager Mira')).toBe(true);
        expect((await get('admin', `/admin/audit?entityId=${lead.publicId}&pageSize=10`)).body.total).toBe(2);
        const today = new Date().toISOString().slice(0, 10);
        expect((await get('admin', `/admin/audit?from=${today}&to=${today}&entityId=${lead.publicId}`)).body.total).toBe(2);
        expect((await get('admin', '/admin/audit?from=2020-01-01&to=2020-01-02')).body.total).toBe(0);
        expect((await get('admin', '/admin/audit?from=nonsense')).status).toBe(400);
        expect((await get('admin', '/admin/audit/actions')).body.actions).toContain('lead.dnc_set');
    });

    it('reads and changes settings, with defaults and an audit line', async () => {
        const first = await get('admin', '/admin/settings');
        expect(first.status).toBe(200);
        expect(first.body.settings.map((s: { key: string; value: number }) => [s.key, s.value])).toEqual([
            ['reports.firstResponseTargetMinutes', 60],
            ['reports.stageStaleDays', 7],
        ]);
        expect((await get('manager', '/admin/settings')).status).toBe(403);
        expect((await send('manager', 'patch', '/admin/settings', { 'reports.stageStaleDays': 3 })).status).toBe(403);
        expect((await send('admin', 'patch', '/admin/settings', {})).status).toBe(400);
        expect((await send('admin', 'patch', '/admin/settings', { 'reports.stageStaleDays': 0 })).status).toBe(400);
        expect((await send('admin', 'patch', '/admin/settings', { 'reports.stageStaleDays': 2.5 })).status).toBe(400);
        expect((await send('admin', 'patch', '/admin/settings', { other: 1 })).status).toBe(400);

        const saved = await send('admin', 'patch', '/admin/settings', { 'reports.stageStaleDays': 3, 'reports.firstResponseTargetMinutes': 60 });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect(saved.body.settings.find((s: { key: string }) => s.key === 'reports.stageStaleDays').value).toBe(3);
        expect((await get('admin', '/admin/settings')).body.settings[1].value).toBe(3);
        const logged = await db.auditLog.findMany({ where: { action: 'settings.changed' } });
        expect(logged).toHaveLength(1);
        expect(logged[0].detail).toEqual({ 'reports.stageStaleDays': { from: 7, to: 3 } });
        await send('admin', 'patch', '/admin/settings', { 'reports.stageStaleDays': 3 });
        expect(await db.auditLog.count({ where: { action: 'settings.changed' } })).toBe(1);
    });
});
