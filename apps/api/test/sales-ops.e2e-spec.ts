/**
 * Managing lead sources, recording payment on won deals (and revenue in Reports), and merging duplicate leads,
 * against a REAL MySQL/MariaDB database. Only Redis is faked.
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- sales-ops
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

describe.skipIf(!enabled)('Sources, payments and merging (real database)', () => {
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
        await db.leadSource.create({ data: { name: 'VSL job-switch', group: 'VSL', matchRule: { system: 'VSL_FORM' } } });
        await db.leadSource.create({ data: { name: 'CSV import', group: 'IMPORT' } });
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
            'enrolments', 'lead_list_members', 'lead_lists', 'lead_score_entries', 'lead_events', 'lead_assignments', 'distribution_cursors', 'notifications', 'opportunity_stage_changes',
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

    const send = async (key: string, method: 'post' | 'patch' | 'put', path: string, body: unknown) => {
        const s = await session(key);
        return s.agent[method](`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body as object);
    };
    const get = async (key: string, path: string) => (await session(key)).agent.get(`/api/v1${path}`);
    const source = (name: string) => db.leadSource.findFirstOrThrow({ where: { name } });

    async function makeLead(n: number, over: { owner?: string | null; name?: string; stage?: 'CALL_1' | 'TEST' | 'PAYMENT_FINANCING' | null; email?: string | null } = {}) {
        const src = await source('WorkR');
        const email = over.email === undefined ? `p${n}@example.com` : over.email;
        const lead = await db.lead.create({
            data: {
                fullName: over.name ?? `Person ${n}`, email, phoneLast10: mobile(n), phoneE164: `+91${mobile(n)}`,
                ownerId: over.owner ? users[over.owner].id : null, firstSourceId: src.id, capturedAt: new Date(Date.now() - n * 60_000),
                identities: { create: [...(email ? [{ type: 'EMAIL' as const, value: email }] : []), { type: 'PHONE' as const, value: mobile(n) }] },
            },
        });
        const opportunity = over.stage === null ? null : await db.opportunity.create({
            data: { leadId: lead.id, openLeadId: lead.id, stage: over.stage ?? 'PAYMENT_FINANCING', status: 'OPEN', ownerId: lead.ownerId, stageChangedAt: new Date() },
        });
        return { ...lead, opportunity };
    }

    describe('lead sources', () => {
        it('an admin sees every source, adds one, and it can be picked for a new lead', async () => {
            await makeLead(1);
            const list = await get('admin', '/sources');
            expect(list.status).toBe(200);
            const by = Object.fromEntries((list.body.sources as Array<{ name: string; system: boolean; leads: number }>).map((s) => [s.name, s]));
            expect(by.WorkR).toMatchObject({ system: true, leads: 1 });
            expect(by['VSL job-switch']!.system).toBe(true);
            expect(by['CSV import']!.system).toBe(true);
            expect(by.Organic!.system).toBe(true);

            const made = await send('admin', 'post', '/sources', { name: ' Webinar ', group: 'OTHER' });
            expect(made.status, JSON.stringify(made.body)).toBe(201);
            expect(made.body).toMatchObject({ name: 'Webinar', group: 'OTHER', isActive: true, system: false, leads: 0 });
            const filters = await get('bda1', '/leads/filters');
            expect((filters.body.sources as Array<{ name: string }>).map((s) => s.name)).toContain('Webinar');
            const lead = await send('bda1', 'post', '/leads', { fullName: 'From A Webinar', phone: '9876511111', sourceId: made.body.id });
            expect(lead.status).toBe(201);
            expect(await db.auditLog.count({ where: { action: 'lead_source.created', entityId: String(made.body.id) } })).toBe(1);
        });

        it('renames and switches off its own sources, but never the CRM\'s own, and refuses a taken name', async () => {
            const made = await send('admin', 'post', '/sources', { name: 'Walk-in', group: 'OTHER' });
            const renamed = await send('admin', 'patch', `/sources/${made.body.id}`, { name: 'Office walk-in', group: 'REFERRAL' });
            expect(renamed.body).toMatchObject({ name: 'Office walk-in', group: 'REFERRAL' });
            const off = await send('admin', 'patch', `/sources/${made.body.id}`, { isActive: false });
            expect(off.body.isActive).toBe(false);
            expect(((await get('bda1', '/leads/filters')).body.sources as Array<{ name: string }>).map((s) => s.name)).not.toContain('Office walk-in');
            expect((await send('bda1', 'post', '/leads', { fullName: 'Too Late', phone: '9876511112', sourceId: made.body.id })).status).toBe(400);

            for (const name of ['WorkR', 'Organic', 'CSV import', 'VSL job-switch']) {
                const locked = await send('admin', 'patch', `/sources/${(await source(name)).id}`, { isActive: false });
                expect(locked.status, name).toBe(409);
                expect(locked.body.code).toBe('SOURCE_LOCKED');
            }
            expect((await send('admin', 'post', '/sources', { name: 'organic', group: 'OTHER' })).body.code).toBe('SOURCE_NAME_TAKEN');
            expect((await send('admin', 'post', '/sources', { name: 'Sneaky', group: 'VSL' })).status).toBe(400);
            expect((await send('admin', 'patch', '/sources/99999', { isActive: false })).status).toBe(404);
            for (const key of ['manager', 'bda1', 'ops']) expect((await get(key, '/sources')).status, key).toBe(403);
        });
    });

    describe('payment on won deals', () => {
        const pay = { program: 'AI-Proof Engineer Program', feeAmount: 120000, amountCollected: 30000, paymentMode: 'EMI', note: 'EMI over 6 months', wonOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) };

        const { wonOn: _wonOn, ...putPay } = pay;

        it('needs the day it was won, which is kept on the deal', async () => {
            const lead = await makeLead(18, { owner: 'bda1' });
            const { wonOn, ...without } = pay;
            const missing = await send('manager', 'post', `/leads/${lead.publicId}/opportunity/won`, without);
            expect(missing.status).toBe(400);
            expect(missing.body.fields?.wonOn ?? missing.body.message).toBeTruthy();
            const future = new Date(Date.now() + 330 * 60_000 + 2 * 86_400_000).toISOString().slice(0, 10);
            expect((await send('manager', 'post', `/leads/${lead.publicId}/opportunity/won`, { ...pay, wonOn: future })).body.code).toBe('STAGE_DATE_INVALID');
            const earlier = new Date(Date.now() + 330 * 60_000 - 3 * 86_400_000).toISOString().slice(0, 10);
            const res = await send('manager', 'post', `/leads/${lead.publicId}/opportunity/won`, { ...pay, wonOn: earlier });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.opportunity.wonOn).toBe(earlier);
            expect((await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id } })).wonOn?.toISOString().slice(0, 10)).toBe(earlier);
        });

        it('a closer closes the deal as won with what was agreed and collected', async () => {
            const lead = await makeLead(10, { owner: 'bda1' });
            const res = await send('closer', 'post', `/leads/${lead.publicId}/opportunity/won`, pay);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.opportunity).toMatchObject({ status: 'WON', stage: 'CLOSED_WON', enrolment: { program: 'AI-Proof Engineer Program', feeAmount: 120000, amountCollected: 30000, paymentMode: 'EMI' } });
            expect(res.body.lead.lifecycle).toBe('ENROLLED');
            expect(await db.enrolment.count({ where: { opportunityId: lead.opportunity!.id, recordedById: users.closer.id } })).toBe(1);
            const event = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: 'OPPORTUNITY_WON' } });
            expect(event.data).toMatchObject({ paymentMode: 'EMI' });
            expect(await db.auditLog.count({ where: { action: 'lead.won', entityId: lead.publicId } })).toBe(1);
        });

        it('checks the numbers and who may close', async () => {
            const lead = await makeLead(11, { owner: 'bda1' });
            const tooMuch = await send('manager', 'post', `/leads/${lead.publicId}/opportunity/won`, { ...pay, amountCollected: 200000 });
            expect(tooMuch.status).toBe(400);
            expect(Object.keys(tooMuch.body.fields)).toContain('amountCollected');
            expect((await send('manager', 'post', `/leads/${lead.publicId}/opportunity/won`, { ...pay, feeAmount: 0 })).status).toBe(400);
            expect((await send('manager', 'post', `/leads/${lead.publicId}/opportunity/won`, { ...pay, paymentMode: 'CASH' })).status).toBe(400);
            expect((await send('bda1', 'post', `/leads/${lead.publicId}/opportunity/won`, pay)).status).toBe(403);
            expect((await db.opportunity.findUniqueOrThrow({ where: { id: lead.opportunity!.id } })).status).toBe('OPEN');
            const none = await makeLead(12, { stage: null });
            expect((await send('manager', 'post', `/leads/${none.publicId}/opportunity/won`, pay)).body.code).toBe('NO_OPEN_OPPORTUNITY');
        });

        it('payments are kept up to date afterwards, and a win made without them can get them later', async () => {
            const lead = await makeLead(13, { owner: 'bda2' });
            await send('closer', 'post', `/leads/${lead.publicId}/opportunity/won`, pay);
            const more = await send('manager', 'put', `/leads/${lead.publicId}/enrolment`, { ...putPay, amountCollected: 60000 });
            expect(more.status, JSON.stringify(more.body)).toBe(200);
            expect(more.body.opportunity.enrolment.amountCollected).toBe(60000);

            const old = await makeLead(14, { owner: 'bda2' });
            await send('manager', 'post', `/leads/${old.publicId}/opportunity/stage`, { stage: 'CLOSED_WON', date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) });
            expect((await get('manager', `/leads/${old.publicId}`)).body.opportunity.enrolment).toBeNull();
            const later = await send('admin', 'put', `/leads/${old.publicId}/enrolment`, { feeAmount: 90000, amountCollected: 90000, paymentMode: 'FULL' });
            expect(later.body.opportunity.enrolment).toMatchObject({ feeAmount: 90000, paymentMode: 'FULL', program: null });

            const open = await makeLead(15);
            expect((await send('manager', 'put', `/leads/${open.publicId}/enrolment`, putPay)).body.code).toBe('NOT_WON');
            expect((await send('bda2', 'put', `/leads/${lead.publicId}/enrolment`, putPay)).status).toBe(403);
        });

        it('Reports show what was booked, collected and still to collect, and the wins with no payment recorded', async () => {
            const a = await makeLead(16, { owner: 'bda1' });
            const b = await makeLead(17, { owner: 'bda1' });
            const c = await makeLead(18, { owner: 'bda2' });
            const d = await makeLead(19, { owner: 'bda2' });
            await send('closer', 'post', `/leads/${a.publicId}/opportunity/won`, pay);
            await send('closer', 'post', `/leads/${b.publicId}/opportunity/won`, { feeAmount: 80000, amountCollected: 80000, paymentMode: 'FULL', wonOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) });
            await send('closer', 'post', `/leads/${c.publicId}/opportunity/won`, { feeAmount: 100000, amountCollected: 10000, paymentMode: 'LOAN', wonOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) });
            await send('manager', 'post', `/leads/${d.publicId}/opportunity/stage`, { stage: 'CLOSED_WON', date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) });

            const team = await get('manager', '/reports/summary?days=30');
            expect(team.status).toBe(200);
            expect(team.body.revenue).toMatchObject({ booked: 300000, collected: 120000, pending: 180000, averageFee: 100000, unrecorded: 1 });
            expect(team.body.revenue.byMode).toEqual([
                { mode: 'FULL', deals: 1, booked: 80000 },
                { mode: 'EMI', deals: 1, booked: 120000 },
                { mode: 'LOAN', deals: 1, booked: 100000 },
                { mode: 'PART', deals: 0, booked: 0 },
            ]);
            const rows = Object.fromEntries((team.body.bdas as Array<{ name: string; revenue: number }>).map((r) => [r.name, r.revenue]));
            expect(rows).toMatchObject({ 'BDA Bose': 200000, 'BDA Rao': 100000 });
            const own = await get('bda1', '/reports/summary?days=30');
            expect(own.body.revenue).toMatchObject({ booked: 200000, unrecorded: 0 });
        });
    });

    describe('merging duplicates', () => {
        async function richPair() {
            const keep = await makeLead(30, { owner: 'bda1', name: 'Asha Verma', stage: 'CALL_1' });
            const drop = await makeLead(31, { name: 'Asha Verma', stage: 'TEST', email: 'asha.old@example.com' });
            await db.lead.update({ where: { id: drop.id }, data: { currentCompany: 'Infosys', currentCtc: '9 LPA', vslDepth: 'BOOKED', temperature: 'HOT', capturedAt: new Date(Date.now() - 86_400_000) } });
            await db.activity.create({ data: { leadId: keep.id, userId: users.bda1.id, kind: 'NOTE', notes: 'kept note' } });
            await db.activity.create({ data: { leadId: drop.id, userId: users.bda2.id, kind: 'NOTE', notes: 'dup note' } });
            await db.task.create({ data: { leadId: drop.id, assigneeId: users.bda2.id, type: 'FOLLOW_UP', title: 'Call back', dueAt: new Date(Date.now() + 3_600_000) } });
            await db.leadEvent.create({ data: { leadId: drop.id, type: 'LEAD_CREATED', actorType: 'SYSTEM', data: {}, occurredAt: new Date() } });
            await db.formResponse.create({ data: { leadId: keep.id, formSlug: 'job-switch', submissionRef: 'sub-keep', score: 60, answers: [], submittedAt: new Date(Date.now() - 7_200_000) } });
            await db.formResponse.create({ data: { leadId: drop.id, formSlug: 'job-switch', submissionRef: 'sub-drop', score: 40, answers: [], submittedAt: new Date(Date.now() - 3_600_000) } });
            await db.leadScoreEntry.createMany({ data: [
                { leadId: keep.id, points: 60, reason: 'VSL_FORM_SCORE' }, { leadId: keep.id, points: 5, reason: 'CALL_CONNECTED' },
                { leadId: drop.id, points: 40, reason: 'VSL_FORM_SCORE' }, { leadId: drop.id, points: 10, reason: 'IMPORT_INITIAL' },
            ] });
            await db.booking.create({ data: { leadId: drop.id, bookingRef: 'bk-31', submissionRef: 'sub-drop', slotStartAt: new Date(Date.now() + 86_400_000), slotLabel: 'Tomorrow 4 pm', status: 'CONFIRMED' } });
            const list = await db.leadList.create({ data: { name: 'Nov batch', createdById: users.manager.id } });
            const other = await db.leadList.create({ data: { name: 'Webinar list', createdById: users.manager.id } });
            await db.leadListMember.createMany({ data: [{ listId: list.id, leadId: keep.id }, { listId: list.id, leadId: drop.id }, { listId: other.id, leadId: drop.id }] });
            return { keep, drop };
        }

        it('moves everything to the kept lead and keeps the duplicate as a pointer', async () => {
            const { keep, drop } = await richPair();
            const res = await send('manager', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: drop.publicId });
            expect(res.status, JSON.stringify(res.body)).toBe(200);

            const kept = await db.lead.findUniqueOrThrow({ where: { id: keep.id }, include: { identities: true, listMembers: true } });
            expect(kept.identities.map((i) => i.value).sort()).toEqual(['asha.old@example.com', 'p30@example.com', mobile(30), mobile(31)].sort());
            expect(kept).toMatchObject({ ownerId: users.bda1.id, email: 'p30@example.com', currentCompany: 'Infosys', vslDepth: 'BOOKED', temperature: 'HOT' });
            expect(kept.capturedAt.getTime()).toBeLessThan(Date.now() - 80_000_000);
            expect(kept.listMembers).toHaveLength(2);
            // The newest form (40) counts once, plus everything else: 5 + 10 + 40.
            expect(kept.leadScore).toBe(55);
            expect((await db.lead.findUniqueOrThrow({ where: { id: drop.id } })).mergedIntoId).toBe(keep.id);

            const opps = await db.opportunity.findMany({ where: { leadId: keep.id }, orderBy: { id: 'asc' } });
            expect(opps.map((o) => [o.stage, o.status])).toEqual([['CALL_1', 'MERGED'], ['TEST', 'OPEN']]);
            expect(opps[1]!.ownerId).toBe(users.bda1.id);
            expect(await db.opportunity.count({ where: { leadId: drop.id } })).toBe(0);
            expect(await db.activity.count({ where: { leadId: keep.id } })).toBe(2);
            expect(await db.task.findFirstOrThrow({ where: { leadId: keep.id } })).toMatchObject({ assigneeId: users.bda1.id, status: 'OPEN' });
            expect(await db.booking.count({ where: { leadId: keep.id } })).toBe(1);
            expect(await db.leadEvent.count({ where: { leadId: keep.id, type: 'LEADS_MERGED' } })).toBe(1);
            expect(await db.leadEvent.count({ where: { leadId: drop.id } })).toBe(0);
            expect(res.body.opportunity).toMatchObject({ stage: 'TEST', status: 'OPEN' });
            expect(await db.auditLog.count({ where: { action: 'lead.merged', entityId: keep.publicId } })).toBe(1);

            // The duplicate's old link leads on to the kept lead; the list and the bda's queue show one person.
            const old = await get('manager', `/leads/${drop.publicId}`);
            expect(old.status).toBe(404);
            expect(old.body).toMatchObject({ code: 'LEAD_MERGED', existing: { id: keep.publicId } });
            const search = await get('manager', '/leads?search=Asha');
            expect((search.body.leads as Array<{ id: string }>).map((l) => l.id)).toEqual([keep.publicId]);

            // Once merged, the old email and phone find the kept lead.
            const again = await send('manager', 'post', '/leads', { fullName: 'Asha V', email: 'asha.old@example.com', phone: mobile(30), sourceId: (await source('Organic')).id });
            expect(again.status).toBe(409);
            expect(again.body.existing.id).toBe(keep.publicId);

            // Repeating it changes nothing.
            const twice = await send('manager', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: drop.publicId });
            expect(twice.status).toBe(200);
            expect(await db.leadEvent.count({ where: { leadId: keep.id, type: 'LEADS_MERGED' } })).toBe(1);
        });

        it('suggests same-name leads, and only managers and admins may merge', async () => {
            const { keep, drop } = await richPair();
            await makeLead(32, { name: 'Someone Else' });
            const dups = await get('manager', `/leads/${keep.publicId}/duplicates`);
            expect((dups.body.leads as Array<{ id: string }>).map((l) => l.id)).toEqual([drop.publicId]);
            expect((await get('bda1', `/leads/${keep.publicId}/duplicates`)).status).toBe(403);
            expect((await send('bda1', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: drop.publicId })).status).toBe(403);
            expect((await send('manager', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: keep.publicId })).status).toBe(400);
            expect((await send('manager', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: '99999999-9999-4999-8999-999999999999' })).status).toBe(404);
            // The merged-away lead cannot be the one kept.
            await send('manager', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: drop.publicId });
            const third = await makeLead(33, { name: 'Asha Verma' });
            expect((await send('manager', 'post', `/leads/${drop.publicId}/merge`, { duplicateId: third.publicId })).body.code).toBe('LEAD_MERGED');
        });

        it('a kept lead with no owner takes the duplicate\'s owner, and the open deal further along stays open', async () => {
            const keep = await makeLead(40, { stage: 'TEST' });
            const drop = await makeLead(41, { owner: 'bda2', stage: 'CALL_1' });
            await send('admin', 'post', `/leads/${keep.publicId}/merge`, { duplicateId: drop.publicId });
            expect((await db.lead.findUniqueOrThrow({ where: { id: keep.id } })).ownerId).toBe(users.bda2.id);
            const opps = await db.opportunity.findMany({ where: { leadId: keep.id }, orderBy: { id: 'asc' } });
            expect(opps.map((o) => [o.stage, o.status, o.ownerId])).toEqual([['TEST', 'OPEN', users.bda2.id], ['CALL_1', 'MERGED', users.bda2.id]]);
        });
    });
});
