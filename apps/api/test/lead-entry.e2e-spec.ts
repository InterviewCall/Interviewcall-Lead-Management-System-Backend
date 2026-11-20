/**
 * Adding a lead by hand, editing a lead's details, handing a leaver's leads to the team, and alerts for leads whose
 * owner has left, against a REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- lead-entry
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
import { InboxService } from '../src/modules/engagement/inbox.service.js';
import { LeadsService } from '../src/modules/leads/leads.service.js';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('Lead entry, editing and hand-over (real database)', () => {
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

    const post = async (key: string, path: string, body: unknown) => {
        const s = await session(key);
        return s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body as object);
    };
    const patch = async (key: string, path: string, body: unknown) => {
        const s = await session(key);
        return s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body as object);
    };
    const get = async (key: string, path: string) => (await session(key)).agent.get(`/api/v1${path}`);
    const sourceId = async (name: string) => (await db.leadSource.findFirstOrThrow({ where: { name } })).id;
    const leadOf = (publicId: string) => db.lead.findUniqueOrThrow({ where: { publicId }, include: { identities: true, opportunities: true } });

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

    describe('adding a lead by hand', () => {
        it('a BDA owns what they add; it starts at Call 1 Pending with a timeline, log line and audit, and no alert to themselves', async () => {
            const res = await post('bda1', '/leads', {
                fullName: '  Ritu Sharma ', phone: '+91 98765-43210', email: 'Ritu@Example.com', sourceId: await sourceId('Organic'),
                currentCompany: 'TCS', currentCtc: '8 LPA', graduationYear: '2020', domain: 'Backend', ownerId: users.manager.publicId,
            });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            const lead = await leadOf(res.body.id);
            expect(lead).toMatchObject({
                fullName: 'Ritu Sharma', email: 'ritu@example.com', phoneE164: '+919876543210', phoneLast10: '9876543210',
                currentCompany: 'TCS', currentCtc: '8 LPA', graduationYear: '2020', domain: 'Backend',
                ownerId: users.bda1.id, lifecycleStage: 'MARKETING_LEAD',
            });
            expect(lead.identities.map((i) => `${i.type}:${i.value}`).sort()).toEqual(['EMAIL:ritu@example.com', 'PHONE:9876543210']);
            expect(lead.opportunities).toHaveLength(1);
            expect(lead.opportunities[0]).toMatchObject({ stage: 'CALL_1_PENDING', status: 'OPEN', ownerId: users.bda1.id });
            expect(await db.leadAssignment.findMany({ where: { leadId: lead.id } })).toMatchObject([{ method: 'MANUAL', toUserId: users.bda1.id, byUserId: users.bda1.id }]);
            expect(await db.notification.count({ where: { userId: users.bda1.id } })).toBe(0);
            expect(await db.auditLog.count({ where: { action: 'lead.created', entityId: res.body.id } })).toBe(1);

            const detail = await get('bda1', `/leads/${res.body.id}`);
            expect(detail.status).toBe(200);
            const titles = (detail.body.events as Array<{ title: string }>).map((e) => e.title);
            expect(titles).toEqual(expect.arrayContaining(['Added by hand', 'Assigned to BDA Bose', 'Opportunity opened at Call 1 Pending']));
        });

        it('a manager may give it to someone, who is told, or leave it for the Assignment queue', async () => {
            const given = await post('manager', '/leads', { fullName: 'Given Away', phone: '9876500011', sourceId: await sourceId('Organic'), ownerId: users.bda2.publicId });
            expect(given.status, JSON.stringify(given.body)).toBe(201);
            expect((await leadOf(given.body.id)).ownerId).toBe(users.bda2.id);
            expect(await db.notification.count({ where: { userId: users.bda2.id, type: 'NEW_ASSIGNMENT' } })).toBe(1);

            const waiting = await post('admin', '/leads', { fullName: 'Nobody Yet', email: 'nobody@example.com', sourceId: await sourceId('Organic') });
            expect(waiting.status).toBe(201);
            expect((await leadOf(waiting.body.id)).ownerId).toBeNull();
            const queue = await get('manager', '/assignment/queue');
            expect((queue.body.items as Array<{ id: string }>).map((i) => i.id)).toContain(waiting.body.id);

            const toCloser = await post('manager', '/leads', { fullName: 'Wrong Owner', phone: '9876500012', sourceId: await sourceId('Organic'), ownerId: users.closer.publicId });
            expect(toCloser.status).toBe(400);
            expect(toCloser.body.code).toBe('ASSIGNEE_INVALID');
        });

        it('never adds a person twice: it names the lead and owner, and only lets the owner open it', async () => {
            const theirs = await makeLead(1, { owner: 'bda2' });
            const byPhone = await post('bda1', '/leads', { fullName: 'Same Phone', phone: `0${mobile(1)}`, sourceId: await sourceId('Organic') });
            expect(byPhone.status).toBe(409);
            expect(byPhone.body).toMatchObject({ code: 'LEAD_EXISTS', message: 'This person is already a lead, owned by BDA Rao', existing: { id: null, name: null, owner: { name: 'BDA Rao' }, canOpen: false } });
            const asManager = await post('manager', '/leads', { fullName: 'Same Email', email: 'P1@example.com', sourceId: await sourceId('Organic') });
            expect(asManager.status).toBe(409);
            expect(asManager.body.existing).toMatchObject({ id: theirs.publicId, name: 'Person 1', canOpen: true });

            await makeLead(2);
            const split = await post('manager', '/leads', { fullName: 'Two People', email: 'p1@example.com', phone: mobile(2), sourceId: await sourceId('Organic') });
            expect(split.status).toBe(409);
            expect(split.body.message).toMatch(/two different leads/);
            expect(await db.lead.count()).toBe(2);
        });

        it('checks what it is given', async () => {
            const organic = await sourceId('Organic');
            const cases: Array<[unknown, number, string]> = [
                [{ fullName: 'No Contact', sourceId: organic }, 400, 'phone'],
                [{ fullName: 'Bad Phone', phone: '12345', sourceId: organic }, 400, 'phone'],
                [{ fullName: 'Bad Email', email: 'not-an-email', sourceId: organic }, 400, 'email'],
                [{ fullName: 'Old Source', phone: '9876500021', sourceId: await sourceId('Old source') }, 400, 'sourceId'],
                [{ fullName: 'X', phone: '9876500022', sourceId: organic }, 400, 'fullName'],
                [{ fullName: 'Bad Year', phone: '9876500023', sourceId: organic, graduationYear: '20' }, 400, 'graduationYear'],
            ];
            for (const [body, status, field] of cases) {
                const res = await post('manager', '/leads', body);
                expect(res.status, JSON.stringify(res.body)).toBe(status);
                expect(Object.keys(res.body.fields ?? {}), JSON.stringify(res.body)).toContain(field);
            }
            for (const key of ['ops', 'closer']) {
                expect((await post(key, '/leads', { fullName: 'Not Mine', phone: '9876500024', sourceId: organic })).status, key).toBe(403);
            }
            expect(await db.lead.count()).toBe(0);
        });
    });

    describe('who added a lead, and when it was last worked', () => {
        const rowOf = async (key: string, id: string) => {
            const res = await get(key, '/leads?view=all&pageSize=100');
            expect(res.status).toBe(200);
            return (res.body.leads as Array<{ id: string; addedBy: string | null; lastActivityAt: string | null; createdAt: string }>).find((l) => l.id === id);
        };

        it('names the person who typed a lead in, and shows no last activity until something is logged', async () => {
            const res = await post('bda1', '/leads', { fullName: 'Added Row', phone: '+91 98111-00001', sourceId: await sourceId('Organic') });
            expect(res.status, JSON.stringify(res.body)).toBe(201);

            const row = await rowOf('admin', res.body.id);
            expect(row).toMatchObject({ addedBy: 'BDA Bose', lastActivityAt: null });
            expect(new Date(row?.createdAt ?? '').getTime()).not.toBeNaN();
        });

        it('shows nobody for a lead that arrived by itself, and the time of the last activity once one is logged', async () => {
            const lead = await makeLead(77001, { owner: 'bda1' });
            await db.leadEvent.create({ data: { leadId: lead.id, type: 'LEAD_CREATED', actorType: 'SOURCE', actorId: null, data: { via: 'WORKR' }, occurredAt: new Date() } });
            const at = new Date('2026-11-18T10:30:00.000Z');
            await db.lead.update({ where: { id: lead.id }, data: { lastActivityAt: at } });

            const row = await rowOf('admin', lead.publicId);
            expect(row).toMatchObject({ addedBy: null, lastActivityAt: at.toISOString() });
        });
    });

    describe('last activity counts any work a person does', () => {
        const event = (leadId: bigint, type: string, at: string, actor: 'USER' | 'SYSTEM' = 'USER') =>
            db.leadEvent.create({ data: { leadId, type, actorType: actor, actorId: actor === 'USER' ? users.bda1.id : null, occurredAt: new Date(at) } });
        const listed = async (publicId: string) =>
            ((await get('admin', '/leads?view=all&pageSize=100')).body.leads as Array<{ id: string; lastActivityAt: string | null; lastActivityBy: string | null }>).find((l) => l.id === publicId);

        it('shows a stage move made without logging a call, in the list and on the lead', async () => {
            const lead = await makeLead(77010, { owner: 'bda1' });
            await event(lead.id, 'OPPORTUNITY_STAGE_CHANGED', '2026-11-19T09:00:00.000Z');

            expect(await listed(lead.publicId)).toMatchObject({ lastActivityAt: '2026-11-19T09:00:00.000Z', lastActivityBy: 'BDA Bose' });
            const detail = await get('admin', `/leads/${lead.publicId}`);
            expect(detail.body.lead).toMatchObject({ lastActivityAt: '2026-11-19T09:00:00.000Z', lastActivityBy: 'BDA Bose' });
        });

        it('is not moved by putting the lead in, handing it over or a system event', async () => {
            const lead = await makeLead(77011, { owner: 'bda1' });
            await event(lead.id, 'LEAD_CREATED', '2026-11-19T09:00:00.000Z');
            await event(lead.id, 'ASSIGNED', '2026-11-19T10:00:00.000Z');
            await event(lead.id, 'OPPORTUNITY_STAGE_CHANGED', '2026-11-19T11:00:00.000Z', 'SYSTEM');

            expect(await listed(lead.publicId)).toMatchObject({ lastActivityAt: null, lastActivityBy: null });
        });

        it('takes the later of a logged call and a stage move', async () => {
            const lead = await makeLead(77012, { owner: 'bda1' });
            await db.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date('2026-11-20T08:00:00.000Z') } });
            await event(lead.id, 'OPPORTUNITY_STAGE_CHANGED', '2026-11-19T09:00:00.000Z');
            // A logged call is the latest, and it has no event to name a person from, so no name is shown.
            expect(await listed(lead.publicId)).toMatchObject({ lastActivityAt: '2026-11-20T08:00:00.000Z', lastActivityBy: null });

            await event(lead.id, 'TASK_DONE', '2026-11-20T09:30:00.000Z');
            expect(await listed(lead.publicId)).toMatchObject({ lastActivityAt: '2026-11-20T09:30:00.000Z', lastActivityBy: 'BDA Bose' });
        });
    });

    describe('editing a lead', () => {
        it('changes the details, swaps the identities and records what changed, not the values', async () => {
            const lead = await makeLead(10, { owner: 'bda1' });
            const res = await patch('bda1', `/leads/${lead.publicId}`, {
                fullName: 'Person Ten', phone: '98765 00031', email: 'ten@new.com', currentCompany: 'Infosys', currentCtc: '12 LPA', graduationYear: '2018', domain: '',
            });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.lead).toMatchObject({ name: 'Person Ten', phone: '+919876500031', email: 'ten@new.com' });
            const row = await leadOf(lead.publicId);
            expect(row).toMatchObject({ currentCompany: 'Infosys', currentCtc: '12 LPA', graduationYear: '2018', domain: null });
            expect(row.identities.map((i) => `${i.type}:${i.value}`).sort()).toEqual(['EMAIL:ten@new.com', 'PHONE:9876500031']);
            expect(row.editedFields).toEqual(expect.arrayContaining(['fullName', 'phone', 'email', 'currentCompany', 'currentCtc', 'graduationYear']));
            const event = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: 'DETAILS_EDITED' } });
            expect(JSON.stringify(event.data)).not.toContain('Infosys');
            expect(await db.auditLog.count({ where: { action: 'lead.edited', entityId: lead.publicId } })).toBe(1);

            // The old phone is free again: that person can now be added.
            const freed = await post('manager', '/leads', { fullName: 'Old Number', phone: mobile(10), sourceId: await sourceId('Organic') });
            expect(freed.status, JSON.stringify(freed.body)).toBe(201);
        });

        it('refuses an email or phone another lead holds, and then changes nothing at all', async () => {
            const lead = await makeLead(11, { owner: 'bda1' });
            await makeLead(12, { owner: 'bda2' });
            const res = await patch('bda1', `/leads/${lead.publicId}`, { email: 'fresh@example.com', phone: mobile(12), currentCompany: 'Wipro' });
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'LEAD_EXISTS', fields: { phone: expect.any(String) }, existing: { canOpen: false, owner: { name: 'BDA Rao' } } });
            const row = await leadOf(lead.publicId);
            expect(row).toMatchObject({ email: 'p11@example.com', phoneLast10: mobile(11), currentCompany: null });
            expect(row.identities.map((i) => i.value).sort()).toEqual(['p11@example.com', mobile(11)].sort());
            expect(await db.leadIdentity.count({ where: { value: 'fresh@example.com' } })).toBe(0);
        });

        it('keeps a phone or an email, checks the phone, and only lets those who may mark the lead edit it', async () => {
            const lead = await makeLead(13, { owner: 'bda1', email: null });
            expect((await patch('bda1', `/leads/${lead.publicId}`, { phone: null })).status).toBe(400);
            expect((await patch('bda1', `/leads/${lead.publicId}`, { phone: '555' })).status).toBe(400);
            expect((await patch('bda1', `/leads/${lead.publicId}`, {})).status).toBe(400);
            expect((await patch('bda2', `/leads/${lead.publicId}`, { currentCompany: 'Peek' })).status).toBe(404);
            expect((await patch('ops', `/leads/${lead.publicId}`, { currentCompany: 'Peek' })).status).toBe(403);
            expect((await patch('manager', `/leads/${lead.publicId}`, { currentCompany: 'HCL' })).status).toBe(200);
            // Nothing changed: no event.
            expect((await patch('manager', `/leads/${lead.publicId}`, { currentCompany: 'HCL' })).status).toBe(200);
            expect(await db.leadEvent.count({ where: { leadId: lead.id, type: 'DETAILS_EDITED' } })).toBe(1);
        });

        it('a later import or signup never fills back a field someone edited, even one they cleared', async () => {
            const lead = await makeLead(14, { owner: 'bda1' });
            await db.lead.update({ where: { id: lead.id }, data: { currentCompany: 'Typo Corp' } });
            expect((await patch('bda1', `/leads/${lead.publicId}`, { currentCompany: null })).status).toBe(200);
            const leads = app.get(LeadsService);
            const outcome = await leads.importLead({
                fields: { fullName: 'Person 14', email: 'p14@example.com', phoneE164: null, phoneLast10: null, currentCompany: 'Typo Corp', currentCtc: '9 LPA', graduationYear: null, domain: null, userType: 'UNKNOWN', custom: {} },
                sourceId: await sourceId('WorkR'), ownerId: null, listId: null, ref: 'test:refill', handling: 'FILL_EMPTY', initialScore: 0, touchpointPayload: {},
            });
            expect(outcome.kind).toBe('MATCHED');
            expect(await leadOf(lead.publicId)).toMatchObject({ currentCompany: null, currentCtc: '9 LPA' });
        });
    });

    describe('handing over a leaver\'s leads', () => {
        it('shares everything they own but enrolled leads, with opportunities and follow-ups, round robin', async () => {
            const a = await makeLead(20, { owner: 'bda1' });
            const b = await makeLead(21, { owner: 'bda1' });
            const c = await makeLead(22, { owner: 'bda1', lifecycle: 'NOT_INTERESTED' });
            const won = await makeLead(23, { owner: 'bda1', lifecycle: 'ENROLLED' });
            await makeLead(24, { owner: 'bda2' });
            await db.task.create({ data: { leadId: a.id, assigneeId: users.bda1.id, type: 'FOLLOW_UP', title: 'Call back', dueAt: new Date(Date.now() + 3_600_000) } });

            const count = await get('manager', `/assignment/owned?userId=${users.bda1.publicId}`);
            expect(count.body).toEqual({ count: 3 });
            const res = await post('manager', '/assignment/move-from', { fromUserId: users.bda1.publicId, toUserIds: [users.bda2.publicId, users.bda3.publicId] });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toMatchObject({ assigned: 3, skipped: 0 });
            const owners = await db.lead.findMany({ where: { id: { in: [a.id, b.id, c.id, won.id] } }, select: { id: true, ownerId: true } });
            const ownerOf = (id: bigint) => owners.find((o) => o.id === id)!.ownerId;
            expect([ownerOf(a.id), ownerOf(b.id), ownerOf(c.id)].filter((o) => o === users.bda2.id)).toHaveLength(2);
            expect([ownerOf(a.id), ownerOf(b.id), ownerOf(c.id)].filter((o) => o === users.bda3.id)).toHaveLength(1);
            expect(ownerOf(won.id)).toBe(users.bda1.id);
            expect((await db.opportunity.findFirstOrThrow({ where: { leadId: a.id } })).ownerId).toBe(ownerOf(a.id));
            expect((await db.task.findFirstOrThrow({ where: { leadId: a.id } })).assigneeId).toBe(ownerOf(a.id));
            const log = await db.leadAssignment.findMany({ where: { reasonCode: 'MOVED_FROM_PERSON' } });
            expect(log).toHaveLength(3);
            expect(new Set(log.map((l) => l.batchId)).size).toBe(1);
            expect(await db.auditLog.count({ where: { action: 'assignment.move_from_person', entityId: users.bda1.publicId } })).toBe(2);
            expect((await get('manager', `/assignment/owned?userId=${users.bda1.publicId}`)).body).toEqual({ count: 0 });
            // It does not touch the daily distribution's rotation.
            expect(await db.distributionCursor.count()).toBe(0);
        });

        it('refuses the leaver themselves, someone on leave, and anyone but managers and admins', async () => {
            await makeLead(25, { owner: 'bda1' });
            expect((await post('manager', '/assignment/move-from', { fromUserId: users.bda1.publicId, toUserIds: [users.bda1.publicId] })).status).toBe(400);
            await post('manager', '/assignment/leave', { userId: users.bda2.publicId, until: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) });
            const away = await post('manager', '/assignment/move-from', { fromUserId: users.bda1.publicId, toUserIds: [users.bda2.publicId] });
            expect(away.body.code).toBe('ASSIGNEE_ON_LEAVE');
            expect((await post('bda3', '/assignment/move-from', { fromUserId: users.bda1.publicId, toUserIds: [users.bda3.publicId] })).status).toBe(403);
            expect((await get('bda3', `/assignment/owned?userId=${users.bda1.publicId}`)).status).toBe(403);
            // A manager can take them too.
            const toManager = await post('admin', '/assignment/move-from', { fromUserId: users.bda1.publicId, toUserIds: [users.manager.publicId] });
            expect(toManager.body).toMatchObject({ assigned: 1, perPerson: [{ name: 'Manager Mira', count: 1 }] });
        });
    });

    describe('alerts for leads whose owner has left', () => {
        it('a booked call or a return to the VSL reaches the managers, not the deactivated owner', async () => {
            const lead = await makeLead(30, { owner: 'bda1' });
            const task = await db.task.create({ data: { leadId: lead.id, assigneeId: users.bda1.id, type: 'SCHEDULED_CALL', title: 'Counselling call', dueAt: new Date(Date.now() + 86_400_000), bookingRef: 'bk-30' } });
            await db.staffUser.update({ where: { id: users.bda1.id }, data: { isActive: false } });
            const inbox = app.get(InboxService);
            await inbox.bookedByOwnedLead(lead.id, users.bda1.id, task.id);
            await inbox.backOnVsl(lead.id, users.bda1.id);
            expect(await db.notification.count({ where: { userId: users.bda1.id } })).toBe(0);
            for (const key of ['manager', 'admin']) {
                const mine = await db.notification.findMany({ where: { userId: users[key].id }, orderBy: { id: 'asc' } });
                expect(mine.map((n) => n.type), key).toEqual(['BOOKED_SLOT_UNASSIGNED', 'LEAD_REENGAGED']);
                expect(mine[0]!.message).toMatch(/has left/);
            }

            await db.staffUser.update({ where: { id: users.bda1.id }, data: { isActive: true } });
            await inbox.bookedByOwnedLead(lead.id, users.bda1.id, task.id);
            expect(await db.notification.count({ where: { userId: users.bda1.id, type: 'LEAD_REENGAGED' } })).toBe(1);
        });
    });
});
