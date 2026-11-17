/**
 * Anonymising a lead (erasure on request), against a
 * REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- anonymise
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

describe.skipIf(!enabled)('Anonymise a lead (real database)', () => {
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




    it('erases the personal details everywhere but keeps the lead for the numbers', async () => {
        const lead = await makeLead(1, { owner: 'bda1' });
        const other = await makeLead(2, { owner: 'bda1' });
        const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        const opp = await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id } });
        await db.opportunity.update({ where: { id: opp.id }, data: { lostNote: 'Rahul said his wife objects' } });
        await db.activity.create({ data: { leadId: lead.id, userId: users.bda1.id, kind: 'CALL', notes: 'Rahul works at Infosys, call after 6pm', connected: true } });
        await db.task.create({ data: { leadId: lead.id, type: 'FOLLOW_UP', title: 'Call Rahul about wife', dueAt: new Date(Date.now() + 3600_000), assigneeId: users.bda1.id } });
        await db.notification.create({ data: { userId: users.bda1.id, type: 'FOLLOWUP_OVERDUE', leadId: lead.id, message: 'Rahul is due' } });
        await db.touchpoint.create({ data: { leadId: lead.id, sourceId: source.id, kind: 'SIGNUP', payload: { name: 'Rahul', phone: mobile(1) }, occurredAt: new Date() } });
        await db.formResponse.create({ data: { leadId: lead.id, formSlug: 'f', submissionRef: 's-1', answers: [{ key: 'a', question: 'Q', answer: 'Rahul' }], submittedAt: new Date() } });
        await db.inboxEvent.create({ data: { eventId: 'e-1', source: 'WORKR', type: 'workr.signup', occurredAt: new Date(), payload: { name: 'Rahul' }, status: 'PROCESSED', leadId: lead.id } });
        await db.leadEvent.create({ data: { leadId: lead.id, type: 'DO_NOT_CONTACT_SET', actorType: 'USER', data: { reason: 'Rahul asked' }, occurredAt: new Date() } });
        await db.lead.update({ where: { id: lead.id }, data: { currentCompany: 'Infosys', custom: { x: 1 }, doNotContact: true } });

        expect((await send('manager', 'post', `/leads/${lead.publicId}/anonymise`, { reason: 'Asked by email' })).status).toBe(403);
        expect((await send('admin', 'post', `/leads/${lead.publicId}/anonymise`, { reason: 'no' })).status).toBe(400);
        expect((await send('admin', 'post', `/leads/${lead.publicId}/anonymise`, {})).status).toBe(400);
        expect((await send('admin', 'post', '/leads/3f2b1c0e-0000-4000-8000-000000000000/anonymise', { reason: 'Asked by email' })).status).toBe(404);

        const res = await send('admin', 'post', `/leads/${lead.publicId}/anonymise`, { reason: 'Asked by email on 15 Nov' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual({ id: lead.publicId, anonymised: true });

        const row = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
        expect(row).toMatchObject({ fullName: 'Anonymised lead', email: null, phoneE164: null, phoneLast10: null, currentCompany: null, doNotContact: true, nextFollowupAt: null });
        expect(row.anonymisedAt).not.toBeNull();
        expect(row.custom).toBeNull();
        expect(await db.leadIdentity.count({ where: { leadId: lead.id } })).toBe(0);
        expect((await db.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).lostNote).toBeNull();
        expect((await db.activity.findFirstOrThrow({ where: { leadId: lead.id } })).notes).toBeNull();
        const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
        expect(task).toMatchObject({ title: 'Task', status: 'CANCELLED' });
        expect((await db.notification.findFirstOrThrow({ where: { leadId: lead.id } })).message).toBe('A lead was anonymised');
        expect((await db.touchpoint.findFirstOrThrow({ where: { leadId: lead.id } })).payload).toBeNull();
        expect((await db.formResponse.findFirstOrThrow({ where: { leadId: lead.id } })).answers).toEqual([]);
        expect((await db.inboxEvent.findFirstOrThrow({ where: { leadId: lead.id } })).payload).toBeNull();
        const events = await db.leadEvent.findMany({ where: { leadId: lead.id } });
        expect(events.every((e) => e.data === null || JSON.stringify(e.data) === '{}')).toBe(true);
        expect(events.map((e) => e.type)).toContain('LEAD_ANONYMISED');
        expect((await db.auditLog.findFirstOrThrow({ where: { action: 'lead.anonymised' } })).detail).toEqual({ reason: 'Asked by email on 15 Nov' });

        // The other lead is untouched, and the erased one no longer shows in searches.
        expect((await db.lead.findUniqueOrThrow({ where: { id: other.id } })).fullName).toBe('Person 2');
        const list = await (await session('admin')).agent.get('/api/v1/leads?search=Anonymised&view=all');
        expect(list.body.leads.map((l: { id: string }) => l.id)).not.toContain(lead.publicId);

        const again = await send('admin', 'post', `/leads/${lead.publicId}/anonymise`, { reason: 'Asked by email again' });
        expect(again.status).toBe(409);
        // The same person arriving again is a new lead, not the erased one.
        expect(await db.lead.count({ where: { phoneLast10: mobile(1) } })).toBe(0);
    });
});
