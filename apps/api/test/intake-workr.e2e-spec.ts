/**
 * WorkR signups arriving in the CRM, against a REAL MySQL/MariaDB database: the source key, the
 * inbox, the worker's processing, the daily list, hand-over to the sales manager, bulk assignment
 * and the Intake monitor. Only Redis is faked (queued events are processed by calling the service).
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- intake-workr
 *
 * The database must already have the migrations applied.
 */
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ModelService } from '@app/model';
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from '@app/rate-limit';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { IMPORTS_QUEUE } from '../src/modules/imports/imports.constants.js';
import { INTAKE_QUEUE } from '../src/modules/intake/intake.constants.js';
import { IntakeService } from '../src/modules/intake/intake.service.js';
import { NOTIFICATIONS_QUEUE } from '../src/notifications/notifications.constants.js';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('WorkR intake (real database)', () => {
    let app: INestApplication;
    let db: ModelService;
    let intake: IntakeService;
    const intakeQueue = { waitUntilReady: () => Promise.resolve(), add: vi.fn().mockResolvedValue({}), close: vi.fn() };
    const users: Record<string, { id: bigint; publicId: string; email: string }> = {};
    let workrKey = '';
    let vslKey = '';

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
        delete process.env.INTAKE_OWNER_EMAIL;

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(RATE_LIMIT_STORE)
            .useValue(new InMemoryRateLimitStore(() => clock))
            .overrideProvider(getQueueToken(NOTIFICATIONS_QUEUE))
            .useValue({ waitUntilReady: () => Promise.resolve(), add: vi.fn(), close: vi.fn() })
            .overrideProvider(getQueueToken(IMPORTS_QUEUE))
            .useValue({ waitUntilReady: () => Promise.resolve(), add: vi.fn(), close: vi.fn() })
            .overrideProvider(getQueueToken(INTAKE_QUEUE))
            .useValue(intakeQueue)
            .compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(ModelService);
        intake = app.get(IntakeService);

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
        await make('admin2', 'Admin Zed', 'ADMIN');
        await make('manager', 'Manager Mira', 'SALES_MANAGER');
        await make('bda1', 'BDA Bose', 'BDA');
        await make('bda2', 'BDA Rao', 'BDA');
        await make('closer', 'Closer Chen', 'CLOSER');
        await make('ops', 'Ops Omar', 'OPS');
        await db.leadSource.create({ data: { name: 'WorkR', group: 'WORKR' } });
        await db.leadSource.create({ data: { name: 'CSV import', group: 'IMPORT' } });

        const admin = await signIn(app, users.admin.email, PASSWORD);
        const wk = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'WorkR User-Service', system: 'WORKR' });
        expect(wk.status, JSON.stringify(wk.body)).toBe(201);
        workrKey = wk.body.key;
        const vk = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'VSL form', system: 'VSL_FORM' });
        vslKey = vk.body.key;
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
            'import_rows', 'import_jobs', 'lead_list_members', 'lead_lists', 'lead_score_entries', 'lead_events', 'lead_assignments',
            'opportunity_stage_changes', 'opportunities', 'touchpoints', 'activities', 'tasks', 'bookings', 'form_responses', 'outcomes',
            'lead_identities', 'leads', 'inbox_events',
        ];
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
    }

    const session = (key: string) => signIn(app, users[key].email, PASSWORD);
    const send = (key: string, body: unknown) =>
        request(app.getHttpServer()).post('/api/v1/intake/events').set('x-intake-key', key).send(body as object);

    const signupEvent = (n: number, over: Record<string, unknown> = {}, at = '2026-11-05T05:30:00Z') => ({
        eventId: `workr-signup-${n}`,
        type: 'workr.signup',
        occurredAt: at,
        payload: {
            userId: n,
            fullName: `Person ${n}`,
            email: `person${n}@example.com`,
            phoneNo: mobile(n),
            details: 'Working Professional',
            domain: 'Backend',
            currentCompany: 'Acme',
            currentCtc: '10 - 15 LPA',
            ...over,
        },
    });

    /** Sends the event and runs the worker on it. */
    async function arrive(event: ReturnType<typeof signupEvent>) {
        const res = await send(workrKey, event);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        await intake.process(BigInt(res.body.id));
        return res.body as { id: string; duplicate: boolean };
    }

    beforeEach(async () => {
        await clearLeadData();
        intakeQueue.add.mockClear();
    });

    describe('the door', () => {
        it('turns away a request with no key, a wrong key and a revoked key', async () => {
            await request(app.getHttpServer()).post('/api/v1/intake/events').send(signupEvent(1)).expect(401);
            await send('ick_not-a-real-key-at-all-0000', signupEvent(1)).expect(401);

            const admin = await session('admin');
            const made = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'Temporary', system: 'WORKR' });
            const tmp = made.body.key as string;
            await send(tmp, signupEvent(1)).expect(202);
            await admin.agent.post(`/api/v1/source-keys/${made.body.sourceKey.id}/revoke`).set('X-CSRF-Token', admin.csrf).expect(200);
            await send(tmp, signupEvent(2)).expect(401);
        });

        it('does not need a staff session or a CSRF token for a good key', async () => {
            const res = await send(workrKey, signupEvent(1));
            expect(res.status).toBe(202);
        });

        it("will not let one system's key send another system's events", async () => {
            const res = await send(vslKey, signupEvent(1));
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('EVENT_TYPE_NOT_ALLOWED');
        });

        it('names the bad field when a payload is not valid, and stores nothing', async () => {
            const res = await send(workrKey, signupEvent(1, { email: 'nope' }));
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('PAYLOAD_INVALID');
            expect(res.body.fields).toHaveProperty('email');
            expect(await db.inboxEvent.count()).toBe(0);
        });

        it('stores a repeated event once and says so', async () => {
            const a = await send(workrKey, signupEvent(1));
            const b = await send(workrKey, signupEvent(1));
            expect(b.status).toBe(202);
            expect(b.body.duplicate).toBe(true);
            expect(b.body.id).toBe(a.body.id);
            expect(await db.inboxEvent.count()).toBe(1);
            expect(intakeQueue.add).toHaveBeenCalledTimes(1);
        });

        it('keeps the event and answers 202 even when the queue is down', async () => {
            intakeQueue.add.mockRejectedValueOnce(new Error('redis down'));
            const res = await send(workrKey, signupEvent(1));
            expect(res.status).toBe(202);
            expect(await db.inboxEvent.count({ where: { status: 'RECEIVED' } })).toBe(1);
            // The sweeper finds it and queues it again.
            await db.inboxEvent.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
            expect(await intake.sweep()).toBe(1);
        });
    });

    describe('a signup becomes a lead', () => {
        it('creates the lead for the admin who has served longest, in the day list, at Call 1 Pending', async () => {
            const sent = await arrive(signupEvent(1));

            const lead = await db.lead.findFirstOrThrow({
                include: { identities: true, touchpoints: true, listMembers: { include: { list: true } }, opportunities: true, firstSource: true },
            });
            expect(lead.fullName).toBe('Person 1');
            expect(lead.email).toBe('person1@example.com');
            expect(lead.phoneE164).toBe(`+91${mobile(1)}`);
            expect(lead.userType).toBe('WORKING_PROFESSIONAL');
            expect(lead.lifecycleStage).toBe('MARKETING_LEAD');
            expect(lead.currentCompany).toBe('Acme');
            expect(lead.ownerId).toBe(users.admin.id);
            expect(lead.firstSource.name).toBe('WorkR');
            expect(lead.identities.map((i) => i.type).sort()).toEqual(['EMAIL', 'PHONE']);
            expect(lead.touchpoints[0]).toMatchObject({ kind: 'SIGNUP', externalRef: 'workr:signup:1' });
            expect(lead.opportunities[0]).toMatchObject({ stage: 'CALL_1_PENDING', status: 'OPEN', ownerId: users.admin.id });
            expect(lead.listMembers[0].list.name).toBe('WorkR signups · 5 Nov 2026');
            expect(lead.listMembers[0].list.originRef).toBe('workr-day:2026-11-05');

            const inbox = await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(sent.id) } });
            expect(inbox).toMatchObject({ status: 'PROCESSED', outcome: 'CREATED', leadId: lead.id, attempts: 1 });

            const log = await db.leadAssignment.findMany({ where: { leadId: lead.id } });
            expect(log).toHaveLength(1);
            expect(log[0]).toMatchObject({ method: 'SYSTEM', toUserId: users.admin.id, byUserId: null });

            const events = await db.leadEvent.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
            expect(events.map((e) => e.type)).toEqual(['LEAD_CREATED', 'ASSIGNED', 'OPPORTUNITY_OPENED']);
        });

        it('puts signups of one Indian day in one list and the next day in another', async () => {
            await arrive(signupEvent(1, {}, '2026-11-05T05:00:00Z'));
            await arrive(signupEvent(2, {}, '2026-11-05T17:00:00Z')); // 22:30 IST, same day
            await arrive(signupEvent(3, {}, '2026-11-05T19:00:00Z')); // 00:30 IST on the 6th
            const lists = await db.leadList.findMany({ orderBy: { id: 'asc' }, include: { _count: { select: { members: true } } } });
            expect(lists.map((l) => [l.name, l._count.members])).toEqual([
                ['WorkR signups · 5 Nov 2026', 2],
                ['WorkR signups · 6 Nov 2026', 1],
            ]);
        });

        it('honours INTAKE_OWNER_EMAIL', async () => {
            process.env.INTAKE_OWNER_EMAIL = users.admin2.email;
            try {
                await arrive(signupEvent(1));
                expect((await db.lead.findFirstOrThrow()).ownerId).toBe(users.admin2.id);
            } finally {
                delete process.env.INTAKE_OWNER_EMAIL;
            }
        });

        it('ignores a student', async () => {
            const sent = await arrive(signupEvent(1, { details: 'Student' }));
            expect(await db.lead.count()).toBe(0);
            expect(await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(sent.id) } })).toMatchObject({ status: 'PROCESSED', outcome: 'IGNORED' });
        });

        it('does not create a second lead when the event is processed twice', async () => {
            const sent = await arrive(signupEvent(1));
            await db.inboxEvent.update({ where: { id: BigInt(sent.id) }, data: { status: 'RECEIVED' } });
            await intake.process(BigInt(sent.id));
            expect(await db.lead.count()).toBe(1);
            expect(await db.opportunity.count()).toBe(1);
            expect(await db.leadAssignment.count()).toBe(1);
        });

        it('records a signup of someone who is already a lead without taking them from their BDA', async () => {
            const bda = users.bda1.id;
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'CSV import' } });
            const existing = await db.lead.create({
                data: {
                    fullName: 'Person 1 (imported)',
                    email: 'person1@example.com',
                    phoneLast10: mobile(1),
                    phoneE164: `+91${mobile(1)}`,
                    ownerId: bda,
                    firstSourceId: source.id,
                    capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'person1@example.com' }, { type: 'PHONE', value: mobile(1) }] },
                },
            });
            const sent = await arrive(signupEvent(1));
            expect(await db.lead.count()).toBe(1);
            const after = await db.lead.findUniqueOrThrow({ where: { id: existing.id }, include: { listMembers: true, touchpoints: true } });
            expect(after.ownerId).toBe(bda);
            expect(after.listMembers).toHaveLength(0);
            expect(after.fullName).toBe('Person 1 (imported)');
            expect(after.currentCompany).toBe('Acme'); // an empty field is filled
            expect(after.touchpoints.map((t) => t.kind)).toEqual(['SIGNUP']);
            expect(await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(sent.id) } })).toMatchObject({ outcome: 'MATCHED', leadId: existing.id });
            expect((await db.leadEvent.findMany({ where: { leadId: existing.id } })).map((e) => e.type)).toEqual(['TOUCHPOINT_ADDED']);
        });

        it('stops for a person to decide when the email and the phone belong to two leads', async () => {
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'CSV import' } });
            const make = (name: string, type: 'EMAIL' | 'PHONE', value: string) =>
                db.lead.create({
                    data: {
                        fullName: name, firstSourceId: source.id, capturedAt: new Date(),
                        ...(type === 'EMAIL' ? { email: value } : { phoneLast10: value }),
                        identities: { create: [{ type, value }] },
                    },
                });
            await make('Email owner', 'EMAIL', 'person1@example.com');
            await make('Phone owner', 'PHONE', mobile(1));
            const sent = await arrive(signupEvent(1));
            const inbox = await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(sent.id) } });
            expect(inbox.status).toBe('DEAD');
            expect(inbox.lastError).toContain('IDENTITY_CONFLICT');
            expect(await db.lead.count()).toBe(2);
        });

        it('tries again later when there is no admin, and works after one exists', async () => {
            await db.staffUser.updateMany({ where: { role: 'ADMIN' }, data: { isActive: false } });
            const sent = await arrive(signupEvent(1));
            let inbox = await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(sent.id) } });
            expect(inbox.status).toBe('FAILED');
            expect(inbox.lastError).toContain('no active admin');
            expect(inbox.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

            await db.staffUser.updateMany({ where: { role: 'ADMIN' }, data: { isActive: true } });
            // The admin presses Retry on the monitor.
            const admin = await session('admin');
            await admin.agent.post(`/api/v1/intake/events/${sent.id}/retry`).set('X-CSRF-Token', admin.csrf).expect(200);
            await intake.process(BigInt(sent.id));
            inbox = await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(sent.id) } });
            expect(inbox.status).toBe('PROCESSED');
            expect(await db.lead.count()).toBe(1);
        });

        it('shows the signup on the lead page timeline', async () => {
            await arrive(signupEvent(1));
            const lead = await db.lead.findFirstOrThrow();
            const manager = await session('manager');
            const res = await manager.agent.get(`/api/v1/leads/${lead.publicId}`);
            expect(res.status).toBe(200);
            const titles = res.body.events.map((e: { title: string }) => e.title);
            expect(titles).toContain('Signed up on WorkR');
            expect(titles).toContain('Assigned to Admin Anu');
            expect(res.body.lead.owner.name).toBe('Admin Anu');
        });
    });

    describe('hand-over', () => {
        async function threeSignups() {
            for (const n of [1, 2, 3]) await arrive(signupEvent(n));
        }

        it('lists the waiting batch for the admin and the manager only', async () => {
            await threeSignups();
            for (const key of ['admin', 'manager']) {
                const s = await session(key);
                const res = await s.agent.get('/api/v1/assignment/batches');
                expect(res.status).toBe(200);
                expect(res.body.batches).toEqual([
                    expect.objectContaining({ name: 'WorkR signups · 5 Nov 2026', total: 3, waiting: 3, ownerName: 'Admin Anu' }),
                ]);
            }
            for (const key of ['bda1', 'closer', 'ops']) {
                const s = await session(key);
                expect((await s.agent.get('/api/v1/assignment/batches')).status).toBe(403);
                expect((await s.agent.get('/api/v1/assignment/assignees')).status).toBe(403);
            }
        });

        it('lets the admin hand the whole batch to the sales manager in one step', async () => {
            await threeSignups();
            const admin = await session('admin');
            const list = await db.leadList.findFirstOrThrow();

            const res = await admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send({ listId: list.publicId, toUserId: users.manager.publicId });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual({ moved: 3, skipped: 0, to: { id: users.manager.publicId, name: 'Manager Mira' } });

            const leads = await db.lead.findMany({ include: { opportunities: true } });
            expect(leads.every((l) => l.ownerId === users.manager.id)).toBe(true);
            expect(leads.every((l) => l.opportunities[0].ownerId === users.manager.id)).toBe(true);

            const log = await db.leadAssignment.findMany({ where: { method: 'BULK' } });
            expect(log).toHaveLength(3);
            expect(log[0]).toMatchObject({ fromUserId: users.admin.id, toUserId: users.manager.id, byUserId: users.admin.id, reasonCode: 'HANDOVER' });
            expect(new Set(log.map((l) => l.batchId)).size).toBe(1);

            const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'assignment.handover' } });
            expect(audit.entityId).toBe(list.publicId);

            const timeline = await db.leadEvent.findMany({ where: { leadId: leads[0].id, type: 'ASSIGNED' }, orderBy: { id: 'asc' } });
            expect(timeline).toHaveLength(2);

            const batches = await admin.agent.get('/api/v1/assignment/batches');
            expect(batches.body.batches[0]).toMatchObject({ total: 3, waiting: 0 });
        });

        it('lets the sales manager take the list for themselves', async () => {
            await threeSignups();
            const manager = await session('manager');
            const list = await db.leadList.findFirstOrThrow();
            const res = await manager.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', manager.csrf).send({ listId: list.publicId, toUserId: users.manager.publicId });
            expect(res.status).toBe(200);
            expect(res.body.moved).toBe(3);
        });

        it('moves only what is still waiting when pressed again', async () => {
            await threeSignups();
            const admin = await session('admin');
            const list = await db.leadList.findFirstOrThrow();
            const body = { listId: list.publicId, toUserId: users.manager.publicId };
            await admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send(body).expect(200);

            const again = await admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send(body);
            expect(again.status).toBe(409);
            expect(again.body.code).toBe('NOTHING_TO_HAND_OVER');

            await arrive(signupEvent(4)); // a late signup of the same day
            const late = await admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send(body);
            expect(late.body.moved).toBe(1);
        });

        it('leaves leads the manager already gave to a BDA alone', async () => {
            await threeSignups();
            const admin = await session('admin');
            const list = await db.leadList.findFirstOrThrow();
            await admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send({ listId: list.publicId, toUserId: users.manager.publicId }).expect(200);
            const first = await db.lead.findFirstOrThrow({ orderBy: { id: 'asc' } });
            await db.lead.update({ where: { id: first.id }, data: { ownerId: users.bda1.id } });
            await arrive(signupEvent(4));
            const res = await admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send({ listId: list.publicId, toUserId: users.manager.publicId });
            expect(res.body.moved).toBe(1);
            expect((await db.lead.findUniqueOrThrow({ where: { id: first.id } })).ownerId).toBe(users.bda1.id);
        });

        it('refuses an unknown list, a list that is not a WorkR batch, and someone who cannot be given leads', async () => {
            await threeSignups();
            const admin = await session('admin');
            const list = await db.leadList.findFirstOrThrow();
            const hand = (body: unknown) => admin.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', admin.csrf).send(body as object);

            expect((await hand({ listId: '00000000-0000-4000-8000-000000000000', toUserId: users.manager.publicId })).status).toBe(404);
            const manual = await db.leadList.create({ data: { name: 'Manual list', createdById: users.admin.id } });
            expect((await hand({ listId: manual.publicId, toUserId: users.manager.publicId })).status).toBe(404);
            for (const key of ['closer', 'ops']) {
                const res = await hand({ listId: list.publicId, toUserId: users[key].publicId });
                expect(res.status).toBe(400);
                expect(res.body.code).toBe('ASSIGNEE_INVALID');
            }
            const same = await hand({ listId: list.publicId, toUserId: users.admin.publicId });
            expect(same.status).toBe(409);
            expect(same.body.code).toBe('SAME_OWNER');
            expect(await db.lead.count({ where: { ownerId: users.admin.id } })).toBe(3);
        });

        it('lets the manager hand chosen leads to BDAs, and rejects a BDA trying it', async () => {
            await threeSignups();
            const manager = await session('manager');
            const list = await db.leadList.findFirstOrThrow();
            await manager.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', manager.csrf).send({ listId: list.publicId, toUserId: users.manager.publicId }).expect(200);
            const leads = await db.lead.findMany({ orderBy: { id: 'asc' } });

            const res = await manager.agent
                .post('/api/v1/assignment/bulk')
                .set('X-CSRF-Token', manager.csrf)
                .send({ leadIds: [leads[0].publicId, leads[1].publicId, '00000000-0000-4000-8000-000000000000'], toUserId: users.bda1.publicId });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({ moved: 2, skipped: 1 });
            expect((await db.lead.findMany({ where: { ownerId: users.bda1.id } })).length).toBe(2);
            expect((await db.opportunity.findMany({ where: { ownerId: users.bda1.id } })).length).toBe(2);

            const bda = await session('bda1');
            const denied = await bda.agent.post('/api/v1/assignment/bulk').set('X-CSRF-Token', bda.csrf).send({ leadIds: [leads[2].publicId], toUserId: users.bda1.publicId });
            expect(denied.status).toBe(403);
        });

        it('a BDA sees a handed-over lead only once it is theirs', async () => {
            await threeSignups();
            const manager = await session('manager');
            const list = await db.leadList.findFirstOrThrow();
            await manager.agent.post('/api/v1/assignment/handover').set('X-CSRF-Token', manager.csrf).send({ listId: list.publicId, toUserId: users.manager.publicId }).expect(200);
            const bda = await session('bda1');
            expect((await bda.agent.get('/api/v1/leads')).body.total).toBe(0);
            const lead = await db.lead.findFirstOrThrow({ orderBy: { id: 'asc' } });
            await manager.agent.post('/api/v1/assignment/bulk').set('X-CSRF-Token', manager.csrf).send({ leadIds: [lead.publicId], toUserId: users.bda1.publicId }).expect(200);
            expect((await bda.agent.get('/api/v1/leads')).body.total).toBe(1);
        });
    });

    describe('the Intake monitor', () => {
        it('is for the admin and ops only', async () => {
            for (const key of ['manager', 'bda1', 'closer']) {
                const s = await session(key);
                expect((await s.agent.get('/api/v1/intake/events')).status).toBe(403);
                expect((await s.agent.get('/api/v1/intake/summary')).status).toBe(403);
                expect((await s.agent.get('/api/v1/source-keys')).status).toBe(403);
            }
            const ops = await session('ops');
            expect((await ops.agent.get('/api/v1/intake/events')).status).toBe(200);
            expect((await ops.agent.get('/api/v1/source-keys')).status).toBe(403); // keys are for the admin only
        });

        it('lists events with the lead name and counts them', async () => {
            await arrive(signupEvent(1));
            await arrive(signupEvent(2, { details: 'Student' }));
            const bad = await arrive(signupEvent(3));
            await db.inboxEvent.update({ where: { id: BigInt(bad.id) }, data: { status: 'DEAD', lastError: 'Boom' } });

            const admin = await session('admin');
            const events = (await admin.agent.get('/api/v1/intake/events')).body.events;
            expect(events).toHaveLength(3);
            expect(events[0]).toMatchObject({ status: 'Dead', detail: 'Boom' });
            expect(events[1]).toMatchObject({ status: 'Processed', detail: 'Skipped: not a working professional', source: 'WorkR · User-Service' });
            expect(events[2]).toMatchObject({ status: 'Processed', detail: 'Person 1', event: 'workr.signup' });
            expect(events[2].leadId).toMatch(/^[0-9a-f-]{36}$/);

            expect((await admin.agent.get('/api/v1/intake/events?status=dead')).body.events).toHaveLength(1);

            const summary = (await admin.agent.get('/api/v1/intake/summary')).body;
            expect(summary).toMatchObject({ received: 3, processed: 2, dead: 1, failed: 0, created: 2 });
            const workr = summary.sources.find((s: { id: string }) => s.id === 'WORKR');
            expect(workr).toMatchObject({ status: 'Healthy', today: 3 });
            expect(workr.spark).toHaveLength(12);
            expect(summary.sources.find((s: { id: string }) => s.id === 'VSL_FORM').status).toBe('Never');
        });

        it('lists, creates once and revokes source keys without ever showing a key again', async () => {
            const admin = await session('admin');
            const list = (await admin.agent.get('/api/v1/source-keys')).body.keys;
            expect(list.length).toBeGreaterThanOrEqual(2);
            expect(JSON.stringify(list)).not.toContain(workrKey);
            expect(list.find((k: { name: string }) => k.name === 'WorkR User-Service')).toMatchObject({ system: 'WORKR', active: true, prefix: workrKey.slice(0, 8) });
            const dup = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'WorkR User-Service', system: 'WORKR' });
            expect(dup.status).toBe(409);
            expect(await db.sourceCredential.count({ where: { keyHash: workrKey } })).toBe(0); // only a hash is stored
        });
    });
});
