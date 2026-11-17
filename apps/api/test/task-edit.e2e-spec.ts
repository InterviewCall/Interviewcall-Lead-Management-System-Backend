/**
 * Changing a follow-up: reschedule, reword and reassign, against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- task-edit
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

describe.skipIf(!enabled)('Editing follow-ups (real database)', () => {
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




    const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

    async function withTask(owner: string) {
        const lead = await makeLead(1, { owner });
        const made = await send(owner === 'bda1' ? 'bda1' : 'manager', 'post', `/leads/${lead.publicId}/tasks`, { title: 'Call back', dueAt: inHours(2) });
        expect(made.status).toBe(200);
        const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
        return { lead, taskId: String(task.id) };
    }

    it('lets the owner move and reword a follow-up, and the lead shows the new time', async () => {
        const { lead, taskId } = await withTask('bda1');
        const later = inHours(30);
        const res = await send('bda1', 'patch', `/tasks/${taskId}`, { dueAt: later, title: 'Send the fee sheet' });
        expect(res.status).toBe(200);
        const task = await db.task.findUniqueOrThrow({ where: { id: BigInt(taskId) } });
        expect(task.title).toBe('Send the fee sheet');
        expect(task.dueAt.toISOString()).toBe(new Date(later).toISOString());
        expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowupAt?.toISOString()).toBe(new Date(later).toISOString());
        expect((await db.leadEvent.findMany({ where: { leadId: lead.id, type: 'TASK_UPDATED' } }))).toHaveLength(1);

        expect((await send('bda1', 'patch', `/tasks/${taskId}`, { dueAt: '2020-01-01T00:00:00Z' })).status).toBe(400);
        expect((await send('bda1', 'patch', `/tasks/${taskId}`, {})).status).toBe(400);
        expect((await send('bda2', 'patch', `/tasks/${taskId}`, { title: 'Mine now' })).status).toBe(404);
    });

    it('lets only a manager or admin hand a follow-up to someone else', async () => {
        const { taskId } = await withTask('bda1');
        const bda2 = users.bda2.publicId;
        expect((await send('bda1', 'patch', `/tasks/${taskId}`, { assigneeId: bda2 })).status).toBe(403);
        expect((await send('manager', 'patch', `/tasks/${taskId}`, { assigneeId: users.admin.publicId })).status).toBe(400);
        expect((await send('manager', 'patch', `/tasks/${taskId}`, { assigneeId: bda2 })).status).toBe(200);
        expect((await db.task.findUniqueOrThrow({ where: { id: BigInt(taskId) } })).assigneeId).toBe(users.bda2.id);
        await db.staffUser.update({ where: { id: users.bda3.id }, data: { isActive: false } });
        expect((await send('admin', 'patch', `/tasks/${taskId}`, { assigneeId: users.bda3.publicId })).status).toBe(400);
        expect((await send('admin', 'patch', `/tasks/${taskId}`, { assigneeId: users.manager.publicId })).status).toBe(200);
    });

    it('refuses to change a closed follow-up or a booked call', async () => {
        const { lead, taskId } = await withTask('bda1');
        const call = await db.task.create({ data: { leadId: lead.id, type: 'SCHEDULED_CALL', title: 'Counselling call', dueAt: new Date(Date.now() + 3600_000), bookingRef: 'b-1', assigneeId: users.bda1.id } });
        expect((await send('bda1', 'patch', `/tasks/${call.id}`, { title: 'x' })).status).toBe(409);
        await send('bda1', 'post', `/tasks/${taskId}/complete`, {});
        expect((await send('bda1', 'patch', `/tasks/${taskId}`, { title: 'x' })).status).toBe(409);
    });
});
