/**
 * The outcome and lost-reason editors, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- outcome-editor
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

describe.skipIf(!enabled)('Outcome and lost-reason editors (real database)', () => {
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

    const base = { requiresFollowup: true, connected: false, countsAsAttempt: true, lifecycle: null, lostReason: null };

    beforeEach(async () => {
        await db.outcome.deleteMany({});
        await db.lostReason.deleteMany({});
        await db.lostReason.create({ data: { name: 'Wrong Number', sortOrder: 0 } });
        await db.lostReason.create({ data: { name: 'Fresher', sortOrder: 1 } });
    });

    it('lets a manager add, change and retire an outcome, and the call form follows', async () => {
        const made = await send('manager', 'post', '/engagement/outcomes', { name: 'Voicemail', ...base });
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        const row = made.body.find((o: { name: string }) => o.name === 'Voicemail');
        expect(row).toMatchObject({ connected: false, countsAsAttempt: true, requiresFollowup: true, isActive: true, lostReason: null, used: 0 });
        expect((await get('bda1', '/engagement/outcomes')).body.map((o: { name: string }) => o.name)).toContain('Voicemail');

        const edited = await send('manager', 'patch', `/engagement/outcomes/${row.id}`, { name: 'Left voicemail', lifecycle: 'NOT_INTERESTED', requiresFollowup: false });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
        expect(edited.body.find((o: { id: number }) => o.id === row.id)).toMatchObject({ name: 'Left voicemail', lifecycle: 'NOT_INTERESTED', requiresFollowup: false, countsAsAttempt: true });

        const stored = await db.outcome.findUniqueOrThrow({ where: { id: row.id } });
        expect(stored.effect).toEqual({ connected: false, countsAsAttempt: true, lifecycle: 'NOT_INTERESTED' });

        await send('manager', 'patch', `/engagement/outcomes/${row.id}`, { isActive: false });
        expect((await get('bda1', '/engagement/outcomes')).body.map((o: { name: string }) => o.name)).not.toContain('Left voicemail');
        expect((await get('admin', '/engagement/outcomes/all')).body.map((o: { name: string }) => o.name)).toContain('Left voicemail');
        expect(await db.auditLog.count({ where: { action: { in: ['outcome.created', 'outcome.updated'] } } })).toBe(3);
    });

    it('checks the outcome fields and who may edit', async () => {
        expect((await send('bda1', 'post', '/engagement/outcomes', { name: 'X1', ...base })).status).toBe(403);
        expect((await get('bda1', '/engagement/outcomes/all')).status).toBe(403);
        const ok = await send('admin', 'post', '/engagement/outcomes', { name: 'Dup', ...base });
        expect(ok.status).toBe(200);
        expect((await send('admin', 'post', '/engagement/outcomes', { name: 'Dup', ...base })).status).toBe(400);
        expect((await send('admin', 'post', '/engagement/outcomes', { name: 'Gone', ...base, lostReason: 'No such reason' })).status).toBe(400);
        expect((await send('admin', 'post', '/engagement/outcomes', { name: 'Odd', ...base, lostReason: 'Fresher', lifecycle: 'PROSPECT' })).status).toBe(400);
        expect((await send('admin', 'patch', '/engagement/outcomes/9999', { name: 'Nope' })).status).toBe(404);
        expect((await send('admin', 'patch', `/engagement/outcomes/${ok.body[0].id}`, {})).status).toBe(400);
    });

    it('logging a call with an edited outcome closes the lead as lost', async () => {
        const made = await send('admin', 'post', '/engagement/outcomes', { name: 'Not a fit', ...base, connected: true, countsAsAttempt: false, requiresFollowup: false, lostReason: 'Fresher' });
        const outcome = made.body.find((o: { name: string }) => o.name === 'Not a fit');
        expect(outcome.lostReason).toBe('Fresher');
        const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        const lead = await db.lead.create({ data: { fullName: 'P', email: 'p@example.com', phoneLast10: mobile(5), phoneE164: `+91${mobile(5)}`, ownerId: users.bda1.id, firstSourceId: source.id, capturedAt: new Date() } });
        await db.opportunity.create({ data: { leadId: lead.id, openLeadId: lead.id, stage: 'CALL_1', status: 'OPEN', ownerId: users.bda1.id, stageChangedAt: new Date() } });
        const res = await send('bda1', 'post', `/leads/${lead.publicId}/activities`, { kind: 'CALL', outcomeId: outcome.id, notes: 'Final year student' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe('LOST');
    });

    it('manages lost reasons and keeps the ones an outcome relies on', async () => {
        const made = await send('manager', 'post', '/pipeline/lost-reasons', { name: 'Moved abroad' });
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        expect(made.body.map((r: { name: string }) => r.name)).toEqual(['Wrong Number', 'Fresher', 'Moved abroad']);
        expect((await send('manager', 'post', '/pipeline/lost-reasons', { name: 'moved abroad' })).status).toBe(409);
        const abroad = made.body.find((r: { name: string }) => r.name === 'Moved abroad');
        const renamed = await send('manager', 'patch', `/pipeline/lost-reasons/${abroad.id}`, { name: 'Relocated', sortOrder: 0 });
        expect(renamed.status).toBe(200);
        expect(renamed.body[0].name).toBe('Wrong Number');
        expect(renamed.body.map((r: { name: string }) => r.name)).toContain('Relocated');

        await send('admin', 'post', '/engagement/outcomes', { name: 'Not a fit', ...base, lostReason: 'Fresher' });
        const fresher = made.body.find((r: { name: string }) => r.name === 'Fresher');
        expect((await send('manager', 'patch', `/pipeline/lost-reasons/${fresher.id}`, { isActive: false })).status).toBe(409);
        expect((await send('manager', 'patch', `/pipeline/lost-reasons/${fresher.id}`, { name: 'Student' })).status).toBe(409);
        expect((await send('manager', 'patch', `/pipeline/lost-reasons/${fresher.id}`, { sortOrder: 7 })).status).toBe(200);

        const retire = await send('manager', 'patch', `/pipeline/lost-reasons/${abroad.id}`, { isActive: false });
        expect(retire.status).toBe(200);
        expect((await get('bda1', '/pipeline/lost-reasons')).body.map((r: { name: string }) => r.name)).not.toContain('Relocated');
        expect((await get('manager', '/pipeline/lost-reasons/all')).body.find((r: { id: number }) => r.id === abroad.id).isActive).toBe(false);
        expect((await send('bda1', 'post', '/pipeline/lost-reasons', { name: 'Nope' })).status).toBe(403);
        expect(await db.auditLog.count({ where: { action: { startsWith: 'lost_reason.' } } })).toBe(4);
    });
});
