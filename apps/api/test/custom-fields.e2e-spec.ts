/**
 * Custom fields: defining them and setting values on leads, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- custom-fields
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

describe.skipIf(!enabled)('Custom fields (real database)', () => {
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

    const send = async (key: string, method: 'post' | 'patch', path: string, body: unknown) => {
        const sess = await session(key);
        return sess.agent[method](`/api/v1${path}`).set('X-CSRF-Token', sess.csrf).send(body as object);
    };

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



    it('lets only an admin define fields, and shows each role the ones it may see', async () => {
        expect((await send('manager', 'post', '/custom-fields', { label: 'Batch', type: 'TEXT' })).status).toBe(403);
        const batch = await send('admin', 'post', '/custom-fields', { label: 'Preferred batch', type: 'SELECT', options: ['Jan', 'Mar'] });
        expect(batch.status).toBe(201);
        expect(batch.body).toMatchObject({ key: 'preferred_batch', type: 'SELECT', options: ['Jan', 'Mar'], active: true });
        expect((await send('admin', 'post', '/custom-fields', { label: 'preferred  batch', type: 'TEXT' })).status).toBe(409);
        expect((await send('admin', 'post', '/custom-fields', { label: 'Pick', type: 'SELECT', options: ['One'] })).status).toBe(400);
        await send('admin', 'post', '/custom-fields', { label: 'Manager note', type: 'TEXT', visibleRoles: ['ADMIN', 'SALES_MANAGER'] });

        expect((await get('bda1', '/custom-fields')).body.fields.map((f: { key: string }) => f.key)).toEqual(['preferred_batch']);
        expect((await get('manager', '/custom-fields')).body.fields).toHaveLength(2);

        const retired = await send('admin', 'patch', '/custom-fields/preferred_batch', { isActive: false, options: ['Jan', 'Mar', 'May'] });
        expect(retired.body).toMatchObject({ active: false, options: ['Jan', 'Mar', 'May'] });
        expect((await get('bda1', '/custom-fields')).body.fields).toHaveLength(0);
        expect((await get('admin', '/custom-fields')).body.fields).toHaveLength(2);
        expect((await send('admin', 'patch', '/custom-fields/missing', { label: 'Nope' })).status).toBe(404);
        expect((await send('admin', 'patch', '/custom-fields/manager_note', { options: ['a', 'b'] })).status).toBe(400);
    });

    it('sets, validates and clears values on a lead', async () => {
        await send('admin', 'post', '/custom-fields', { label: 'Batch', type: 'SELECT', options: ['Jan', 'Mar'] });
        await send('admin', 'post', '/custom-fields', { label: 'Target LPA', type: 'NUMBER' });
        await send('admin', 'post', '/custom-fields', { label: 'Visit day', type: 'DATE' });
        await send('admin', 'post', '/custom-fields', { label: 'Tags', type: 'MULTISELECT', options: ['a', 'b', 'c'] });
        await send('admin', 'post', '/custom-fields', { label: 'Passport', type: 'BOOLEAN', isRequired: true });
        await send('admin', 'post', '/custom-fields', { label: 'Secret', type: 'TEXT', visibleRoles: ['ADMIN'] });
        const mine = await makeLead(1, { owner: 'bda1' });
        const theirs = await makeLead(2, { owner: 'bda2' });
        const id = mine.publicId;

        const ok = await send('bda1', 'patch', `/leads/${id}/custom`, { values: { batch: 'Mar', target_lpa: '18.5', visit_day: '2026-12-01', tags: ['a', 'c'], passport: true } });
        expect(ok.status).toBe(200);
        const form = Object.fromEntries(ok.body.lead.customForm.map((f: { key: string; value: unknown }) => [f.key, f.value]));
        expect(form).toEqual({ batch: 'Mar', target_lpa: 18.5, visit_day: '2026-12-01', tags: ['a', 'c'], passport: true });
        expect(ok.body.lead.customFields).toContainEqual({ label: 'Tags', value: 'a, c' });
        expect(ok.body.lead.customFields).toContainEqual({ label: 'Passport', value: 'Yes' });

        const bad = await send('bda1', 'patch', `/leads/${id}/custom`, { values: { batch: 'Dec', target_lpa: 'lots', secret: 'x', nope: 1 } });
        expect(bad.status).toBe(400);
        expect(Object.keys(bad.body.fields ?? bad.body.error?.fields ?? {}).sort()).toEqual(['batch', 'nope', 'secret', 'target_lpa']);
        const required = await send('bda1', 'patch', `/leads/${id}/custom`, { values: { passport: null } });
        expect(required.status).toBe(400);

        const cleared = await send('bda1', 'patch', `/leads/${id}/custom`, { values: { batch: null, tags: [] } });
        expect(cleared.status).toBe(200);
        expect(cleared.body.lead.customFields.map((f: { label: string }) => f.label).sort()).toEqual(['Passport', 'Target LPA', 'Visit day']);
        expect(cleared.body.lead.customForm.map((f: { key: string }) => f.key)).not.toContain('secret');

        expect((await send('bda1', 'patch', `/leads/${theirs.publicId}/custom`, { values: { batch: 'Jan' } })).status).toBe(404);
        const events = await db.leadEvent.findMany({ where: { leadId: mine.id, type: 'DETAILS_EDITED' } });
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect((await send('ops', 'patch', `/leads/${id}/custom`, { values: { batch: 'Jan' } })).status).toBe(403);
    });
});
