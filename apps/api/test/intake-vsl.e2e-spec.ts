/**
 * VSL leads arriving in the CRM (details, form, booking), against a REAL MySQL/MariaDB database: the source key, the
 * inbox, the worker's processing, the daily list, hand-over to the sales manager, bulk assignment
 * and the Intake monitor. Only Redis is faked (queued events are processed by calling the service).
 *
 * Runs only against a database whose name ends in `_test`, and wipes it:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_e2e_test npm run test:e2e -- intake-vsl
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
import { ImportsService } from '../src/modules/imports/imports.service.js';
import { LeadsService as LeadsServiceForTest } from '../src/modules/leads/leads.service.js';
import { IntakeService } from '../src/modules/intake/intake.service.js';
import { VslReconcileService } from '../src/modules/intake/vsl-reconcile.service.js';
import { ScoringService } from '../src/modules/leads/scoring.service.js';
import { NOTIFICATIONS_QUEUE } from '../src/notifications/notifications.constants.js';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('VSL intake (real database)', () => {
    let app: INestApplication;
    let db: ModelService;
    let intake: IntakeService;
    let imports: ImportsService;
    const intakeQueue = { waitUntilReady: () => Promise.resolve(), add: vi.fn().mockResolvedValue({}), close: vi.fn() };
    const users: Record<string, { id: bigint; publicId: string; email: string }> = {};
    let formKey = '';
    let bookingKey = '';

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
        imports = app.get(ImportsService);

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
        await db.leadSource.create({ data: { name: 'WorkR', group: 'WORKR', matchRule: { system: 'WORKR' }, matchOrder: 10 } });
        await db.leadSource.create({ data: { name: 'Meta ads', group: 'META', matchRule: { system: 'VSL_FORM', utmSource: ['facebook', 'fb', 'ig'] }, matchOrder: 20 } });
        await db.leadSource.create({ data: { name: 'VSL job-switch', group: 'VSL', matchRule: { system: 'VSL_FORM', formSlug: 'job-switch' }, matchOrder: 30 } });
        await db.leadSource.create({ data: { name: 'Organic', group: 'ORGANIC', matchOrder: 900 } });
        await db.leadSource.create({ data: { name: 'CSV import', group: 'IMPORT', matchOrder: 1000 } });

        const admin = await signIn(app, users.admin.email, PASSWORD);
        const fk = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'VSL form details', system: 'VSL_FORM' });
        expect(fk.status, JSON.stringify(fk.body)).toBe(201);
        formKey = fk.body.key;
        const bk = await admin.agent.post('/api/v1/source-keys').set('X-CSRF-Token', admin.csrf).send({ name: 'VSL slot booking', system: 'VSL_BOOKING' });
        bookingKey = bk.body.key;
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
            'lead_identities', 'leads', 'inbox_events', 'notifications',
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

    const SUB = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const who = (n: number, over: Record<string, unknown> = {}) => ({
        fullName: `Vsl Person ${n}`,
        email: `vsl${n}@example.com`,
        phone: mobile(n),
        ...over,
    });

    const detailsEvent = (n: number, over: Record<string, unknown> = {}, at = '2026-11-05T05:30:00Z') => ({
        eventId: `vsl-details-${n}`,
        type: 'vsl.details_submitted',
        occurredAt: at,
        payload: { submissionId: SUB(n), formSlug: 'job-switch', ...who(n), source: 'email', utmSource: null, ...over },
    });
    const formEvent = (n: number, over: Record<string, unknown> = {}, at = '2026-11-05T05:40:00Z') => ({
        eventId: `vsl-form-${n}`,
        type: 'vsl.form_submitted',
        occurredAt: at,
        payload: {
            submissionId: SUB(n), formSlug: 'job-switch', ...who(n), score: 72, temperature: 'warm', submittedAt: at,
            answers: [
                { key: 'company', question: 'Current Company', answer: 'TCS' },
                { key: 'currentCtc', question: 'Current CTC', answer: '10 - 15 LPA' },
                { key: 'urgency', question: 'How soon?', answer: 'Within a month' },
            ],
            ...over,
        },
    });
    const bookedEvent = (n: number, over: Record<string, unknown> = {}, at = '2026-11-05T06:00:00Z') => ({
        eventId: `vsl-booked-${n}`,
        type: 'vsl.slot_booked',
        occurredAt: at,
        payload: { bookingId: String(1000 + n), submissionId: SUB(n), formSlug: 'job-switch', ...who(n), slotStartAt: '2026-11-07T05:30:00Z', slotLabel: '7 Nov 2026, 11:00 AM - 11:30 AM', ...over },
    });
    const completedEvent = (n: number, at = '2026-11-07T06:10:00Z') => ({
        eventId: `vsl-completed-${n}`,
        type: 'vsl.booking_completed',
        occurredAt: at,
        payload: { bookingId: String(1000 + n), submissionId: SUB(n), completedAt: at },
    });

    const cancelledEvent = (n: number, over: Record<string, unknown> = {}, at = '2026-11-06T09:00:00Z') => ({
        eventId: `vsl-cancelled-${n}`,
        type: 'vsl.booking_cancelled',
        occurredAt: at,
        payload: { bookingId: String(1000 + n), submissionId: SUB(n), cancelledAt: at, cancelSource: 'candidate', ...over },
    });
    const rescheduledEvent = (n: number, over: Record<string, unknown> = {}, at = '2026-11-06T09:00:00Z') => ({
        eventId: `vsl-rescheduled-${n}-${String(over.slotLabel ?? 'x').length}`,
        type: 'vsl.booking_rescheduled',
        occurredAt: at,
        payload: { bookingId: String(1000 + n), submissionId: SUB(n), slotStartAt: '2026-11-09T09:30:00Z', slotLabel: '9 Nov 2026, 3:00 PM - 3:30 PM', ...over },
    });
    const reopenedEvent = (n: number, at = '2026-11-07T08:00:00Z') => ({
        eventId: `vsl-reopened-${n}`,
        type: 'vsl.booking_reopened',
        occurredAt: at,
        payload: { bookingId: String(1000 + n), submissionId: SUB(n) },
    });

    const keyFor = (type: string) => (type.startsWith('vsl.slot') || type.startsWith('vsl.booking') ? bookingKey : formKey);

    /** Sends the event with the right key and runs the worker on it. Returns the stored event. */
    async function arrive(event: { eventId: string; type: string; occurredAt?: string; payload?: unknown }) {
        const res = await send(keyFor(event.type), event);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        await intake.process(BigInt(res.body.id));
        return { ...res.body, row: await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(res.body.id) } }) } as { id: string; duplicate: boolean; row: { status: string; outcome: string | null; leadId: bigint | null; lastError: string | null } };
    }

    const leadOf = (n: number) => db.lead.findFirstOrThrow({ where: { email: `vsl${n}@example.com` }, include: { opportunities: true, touchpoints: true, firstSource: true, formResponses: true, bookings: true } });
    const timelineOf = async (leadId: bigint) => (await db.leadEvent.findMany({ where: { leadId }, orderBy: { id: 'asc' } })).map((e) => e.type);

    beforeEach(async () => {
        await clearLeadData();
        intakeQueue.add.mockClear();
    });


    describe('the door', () => {
        it("keeps each key to its own service's events", async () => {
            const wrongForm = await send(formKey, bookedEvent(1));
            expect(wrongForm.status).toBe(400);
            expect(wrongForm.body.code).toBe('EVENT_TYPE_NOT_ALLOWED');
            const wrongBooking = await send(bookingKey, detailsEvent(1));
            expect(wrongBooking.status).toBe(400);
            expect((await send(formKey, formEvent(1))).status).toBe(202);
            expect((await send(bookingKey, bookedEvent(1))).status).toBe(202);
        });
        it('names the bad field of a payload and stores nothing', async () => {
            const res = await send(formKey, detailsEvent(1, { email: 'nope' }));
            expect(res.status).toBe(400);
            expect(res.body.fields).toHaveProperty('email');
            expect(await db.inboxEvent.count()).toBe(0);
        });
    });

    describe('step 1: details', () => {
        it('makes an unassigned lead with an open opportunity at Call 1 Pending', async () => {
            const sent = await arrive(detailsEvent(1));
            expect(sent.row).toMatchObject({ status: 'PROCESSED', outcome: 'CREATED' });
            const lead = await leadOf(1);
            expect(lead).toMatchObject({ fullName: 'Vsl Person 1', phoneE164: `+91${mobile(1)}`, ownerId: null, vslDepth: 'DETAILS', priorityRank: 1000, userType: 'UNKNOWN', formScore: null });
            expect(lead.firstSource.name).toBe('VSL job-switch');
            expect(lead.touchpoints.map((t) => [t.kind, t.externalRef])).toEqual([['DETAILS', `vsl:details:${SUB(1)}`]]);
            expect(lead.opportunities).toHaveLength(1);
            expect(lead.opportunities[0]).toMatchObject({ stage: 'CALL_1_PENDING', status: 'OPEN', ownerId: null, scheduledCallAt: null });
            expect(await timelineOf(lead.id)).toEqual(['LEAD_CREATED', 'OPPORTUNITY_OPENED']);
            expect(await db.leadListMember.count()).toBe(0);
            expect(await db.leadAssignment.count()).toBe(0);
        });

        it('picks the source from the rules: Meta for facebook, Organic for a funnel with no rule', async () => {
            await arrive(detailsEvent(1, { utmSource: 'facebook' }));
            await arrive(detailsEvent(2, { formSlug: 'ai-fear' }));
            expect((await leadOf(1)).firstSource.name).toBe('Meta ads');
            expect((await leadOf(2)).firstSource.name).toBe('Organic');
        });

        it('does nothing twice when the same event is sent or processed again', async () => {
            const first = await arrive(detailsEvent(1));
            const again = await send(formKey, detailsEvent(1));
            expect(again.body).toMatchObject({ duplicate: true, id: first.id });
            await db.inboxEvent.update({ where: { id: BigInt(first.id) }, data: { status: 'RECEIVED' } });
            await intake.process(BigInt(first.id));
            const lead = await leadOf(1);
            expect(await db.lead.count()).toBe(1);
            expect(lead.opportunities).toHaveLength(1);
            expect(lead.touchpoints).toHaveLength(1);
            expect(await timelineOf(lead.id)).toEqual(['LEAD_CREATED', 'OPPORTUNITY_OPENED']);
        });

        it('records a known person coming back without changing what they have', async () => {
            await arrive(detailsEvent(1));
            const lead = await leadOf(1);
            await db.lead.update({ where: { id: lead.id }, data: { ownerId: users.bda1.id, fullName: 'Edited Name' } });
            await arrive({ ...detailsEvent(1), eventId: 'vsl-details-1b', payload: { ...detailsEvent(1).payload, submissionId: SUB(11), fullName: 'Other Spelling' } });
            const after = await leadOf(1);
            expect(await db.lead.count()).toBe(1);
            expect(after).toMatchObject({ ownerId: users.bda1.id, fullName: 'Edited Name' });
            expect(after.touchpoints).toHaveLength(2);
            expect(after.opportunities).toHaveLength(1);
            expect(await timelineOf(after.id)).toEqual(['LEAD_CREATED', 'OPPORTUNITY_OPENED', 'TOUCHPOINT_ADDED']);
        });
    });

    describe('step 2: the form', () => {
        it('adds answers, score and temperature to the same lead and raises its rank', async () => {
            await arrive(detailsEvent(1));
            const sent = await arrive(formEvent(1));
            expect(sent.row).toMatchObject({ status: 'PROCESSED', outcome: 'UPDATED' });
            const lead = await leadOf(1);
            expect(await db.lead.count()).toBe(1);
            expect(lead).toMatchObject({ vslDepth: 'FORM', formScore: 72, temperature: 'WARM', currentCompany: 'TCS', currentCtc: '10 - 15 LPA', priorityRank: 2000 + 200 + 36 });
            expect(lead.formResponses).toHaveLength(1);
            expect(lead.formResponses[0]).toMatchObject({ formSlug: 'job-switch', submissionRef: SUB(1), score: 72, temperature: 'WARM' });
            expect(lead.formResponses[0].answers).toEqual([
                { key: 'company', question: 'Current Company', answer: 'TCS' },
                { key: 'currentCtc', question: 'Current CTC', answer: '10 - 15 LPA' },
                { key: 'urgency', question: 'How soon?', answer: 'Within a month' },
            ]);
            expect(lead.opportunities).toHaveLength(1);
            expect(await timelineOf(lead.id)).toEqual(['LEAD_CREATED', 'OPPORTUNITY_OPENED', 'FORM_SUBMITTED']);
        });

        it('makes the lead by itself when the details event never arrived', async () => {
            const sent = await arrive(formEvent(2));
            expect(sent.row.outcome).toBe('CREATED');
            const lead = await leadOf(2);
            expect(lead).toMatchObject({ vslDepth: 'FORM', ownerId: null });
            expect(await timelineOf(lead.id)).toEqual(['LEAD_CREATED', 'OPPORTUNITY_OPENED', 'FORM_SUBMITTED']);
        });

        it('a hotter form lands above a colder one, and both above bare details', async () => {
            await arrive(detailsEvent(1));
            await arrive(formEvent(2, { temperature: 'cold', score: 40 }));
            await arrive(formEvent(3, { temperature: 'hot', score: 90 }));
            const rank = async (n: number) => (await leadOf(n)).priorityRank;
            expect(await rank(3)).toBeGreaterThan(await rank(2));
            expect(await rank(2)).toBeGreaterThan(await rank(1));
        });
    });

    describe('step 3: the booking', () => {
        it('puts the call on the lead and its opportunity, and the lead on top of the queue', async () => {
            await arrive(detailsEvent(1));
            await arrive(formEvent(1));
            const sent = await arrive(bookedEvent(1));
            expect(sent.row).toMatchObject({ status: 'PROCESSED', outcome: 'UPDATED' });
            const lead = await leadOf(1);
            expect(lead).toMatchObject({ vslDepth: 'BOOKED' });
            expect(lead.priorityRank).toBeGreaterThanOrEqual(3000);
            expect(lead.bookings).toHaveLength(1);
            expect(lead.bookings[0]).toMatchObject({ bookingRef: '1001', status: 'CONFIRMED', slotLabel: '7 Nov 2026, 11:00 AM - 11:30 AM' });
            expect(lead.bookings[0].slotStartAt.toISOString()).toBe('2026-11-07T05:30:00.000Z');
            expect(lead.opportunities[0].scheduledCallAt?.toISOString()).toBe('2026-11-07T05:30:00.000Z');
            expect(await timelineOf(lead.id)).toEqual(['LEAD_CREATED', 'OPPORTUNITY_OPENED', 'FORM_SUBMITTED', 'SLOT_BOOKED']);

            const manager = await session('manager');
            const booked = await manager.agent.get('/api/v1/leads?view=booked');
            expect(booked.body.total).toBe(1);
            expect(booked.body.leads[0].name).toBe('Vsl Person 1');
        });

        it('lists the booked calls by call date, the furthest-away call first, across pages', async () => {
            // Booked in one order, called in another: the list follows the call, not the booking.
            const calls: Array<[number, string]> = [
                [1, '2026-11-22T11:30:00Z'],
                [2, '2026-11-16T09:15:00Z'],
                [3, '2026-11-22T12:15:00Z'],
                [4, '2026-11-21T07:45:00Z'],
            ];
            for (const [n, slotStartAt] of calls) {
                await arrive(detailsEvent(n));
                await arrive(bookedEvent(n, { slotStartAt }));
            }
            const manager = await session('manager');
            const names = async (qs: string) => (await manager.agent.get(`/api/v1/leads?view=booked${qs}`)).body.leads.map((l: { name: string }) => l.name);
            expect(await names('')).toEqual(['Vsl Person 3', 'Vsl Person 1', 'Vsl Person 4', 'Vsl Person 2']);
            expect(await names('&pageSize=2&page=1')).toEqual(['Vsl Person 3', 'Vsl Person 1']);
            expect(await names('&pageSize=2&page=2')).toEqual(['Vsl Person 4', 'Vsl Person 2']);
            expect((await manager.agent.get('/api/v1/leads?view=booked&pageSize=2&page=2')).body.total).toBe(4);
        });

        it('works in any order: a booking first, then the details and the form, never lowering how far they got', async () => {
            await arrive(bookedEvent(1));
            await arrive(detailsEvent(1));
            await arrive(formEvent(1));
            const lead = await leadOf(1);
            expect(await db.lead.count()).toBe(1);
            expect(lead.vslDepth).toBe('BOOKED');
            expect(lead.formScore).toBe(72);
            expect(lead.priorityRank).toBe(3000 + 200 + 36);
            expect(lead.opportunities).toHaveLength(1);
            expect(lead.bookings).toHaveLength(1);
            expect(lead.formResponses).toHaveLength(1);
        });

        it('keeps the furthest step when a person\'s steps are processed at the same moment by different workers', async () => {
            const people = [11, 12, 13, 14, 15, 16];
            const ids: string[] = [];
            for (const n of people) {
                for (const event of [detailsEvent(n), formEvent(n), bookedEvent(n)]) {
                    const res = await send(keyFor(event.type), event);
                    expect(res.status).toBe(202);
                    ids.push(res.body.id);
                }
            }
            // Every event of every person at once, as the worker does with its concurrency.
            await Promise.all(ids.map((id) => intake.process(BigInt(id))));
            // A step that lost a race to create the person is retried, as the sweeper would.
            for (const id of ids) {
                const row = await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(id) } });
                if (row.status !== 'PROCESSED') await intake.process(BigInt(id));
            }
            for (const n of people) {
                const lead = await leadOf(n);
                expect(lead, `person ${n}`).toMatchObject({ vslDepth: 'BOOKED', formScore: 72, temperature: 'WARM' });
                expect(lead.priorityRank).toBe(3000 + 200 + 36);
                expect(lead.opportunities).toHaveLength(1);
                expect(lead.bookings).toHaveLength(1);
                expect(lead.formResponses).toHaveLength(1);
            }
            expect(await db.lead.count()).toBe(people.length);
        });

        it('marks the call done, and waits for a booking it has not seen yet', async () => {
            const early = await arrive(completedEvent(1));
            expect(early.row.status).toBe('FAILED');
            expect(early.row.lastError).toContain('has not reached the CRM yet');

            await arrive(bookedEvent(1));
            await db.inboxEvent.update({ where: { id: BigInt(early.id) }, data: { status: 'RECEIVED' } });
            await intake.process(BigInt(early.id));
            const done = await db.inboxEvent.findUniqueOrThrow({ where: { id: BigInt(early.id) } });
            expect(done).toMatchObject({ status: 'PROCESSED', outcome: 'UPDATED' });
            const lead = await leadOf(1);
            expect(lead.bookings[0]).toMatchObject({ status: 'COMPLETED' });
            expect(lead.bookings[0].completedAt).not.toBeNull();
            expect((await timelineOf(lead.id)).filter((t) => t === 'BOOKING_COMPLETED')).toHaveLength(1);

            // Sent again: nothing changes.
            await db.inboxEvent.update({ where: { id: BigInt(early.id) }, data: { status: 'RECEIVED' } });
            await intake.process(BigInt(early.id));
            expect((await timelineOf(lead.id)).filter((t) => t === 'BOOKING_COMPLETED')).toHaveLength(1);
        });
    });

    describe('a booked call as a task', () => {
        it('is a task due at the slot for the lead\'s owner, once per booking, done when the call is marked done', async () => {
            await db.lead.create({
                data: {
                    fullName: 'Vsl Person 8', email: 'vsl8@example.com', phoneLast10: mobile(8), phoneE164: `+91${mobile(8)}`,
                    ownerId: users.bda1.id, firstSourceId: (await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } })).id, capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'vsl8@example.com' }, { type: 'PHONE', value: mobile(8) }] },
                },
            });
            await arrive(bookedEvent(8));
            await arrive(bookedEvent(8));
            const lead = await leadOf(8);
            const tasks = await db.task.findMany({ where: { leadId: lead.id } });
            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toMatchObject({ type: 'SCHEDULED_CALL', status: 'OPEN', assigneeId: users.bda1.id, bookingRef: '1008' });
            expect(tasks[0].dueAt.toISOString()).toBe('2026-11-07T05:30:00.000Z');
            expect(tasks[0].title).toContain('7 Nov 2026, 11:00 AM');

            await arrive(completedEvent(8));
            expect((await db.task.findUniqueOrThrow({ where: { id: tasks[0].id } })).status).toBe('DONE');
        });

        it('waits for an owner when the lead has none, and goes to the BDA the manager gives the lead to', async () => {
            await arrive(bookedEvent(9));
            const lead = await leadOf(9);
            const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
            expect(task.assigneeId).toBeNull();

            const manager = await session('manager');
            const give = await manager.agent.post('/api/v1/assignment/bulk').set('X-CSRF-Token', manager.csrf).send({ leadIds: [lead.publicId], toUserId: users.bda1.publicId });
            expect(give.status, JSON.stringify(give.body)).toBe(200);
            expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeId).toBe(users.bda1.id);

            const bda = await session('bda1');
            const view = await bda.agent.get(`/api/v1/leads/${lead.publicId}/engagement`);
            expect(view.body.tasks[0]).toMatchObject({ type: 'SCHEDULED_CALL', assignee: 'BDA Bose', status: 'OPEN' });
        });
    });

    describe('people the CRM already knows', () => {
        it('a WorkR lead who then fills the VSL keeps their owner and list, and gains the VSL steps', async () => {
            const list = await db.leadList.create({ data: { name: 'WorkR signups', createdById: users.admin.id } });
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
            const existing = await db.lead.create({
                data: {
                    fullName: 'Vsl Person 5', email: 'vsl5@example.com', phoneLast10: mobile(5), phoneE164: `+91${mobile(5)}`,
                    ownerId: users.manager.id, firstSourceId: source.id, capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'vsl5@example.com' }, { type: 'PHONE', value: mobile(5) }] },
                    listMembers: { create: { listId: list.id } },
                    opportunities: { create: { openLeadId: undefined, stage: 'CALL_1_PENDING', ownerId: users.manager.id } },
                },
            });
            await arrive(formEvent(5));
            await arrive(bookedEvent(5));
            const after = await leadOf(5);
            expect(await db.lead.count()).toBe(1);
            expect(after.id).toBe(existing.id);
            expect(after).toMatchObject({ ownerId: users.manager.id, vslDepth: 'BOOKED', formScore: 72 });
            expect(after.firstSource.name).toBe('WorkR');
            expect(await db.leadListMember.count({ where: { leadId: existing.id } })).toBe(1);
            expect(after.formResponses).toHaveLength(1);
        });

        it('a lead brought in by a real WorkR CSV upload takes the VSL steps, even when the email and phone are written differently', async () => {
            const s = await session('admin');
            const workr = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
            const csv = 'Full Name,Email,Phone\r\nAsha Rao,VSL55@Example.com,+91 90000 00055\r\nOther Person,other@example.com,9111111111\r\n';
            const up = await s.agent.post('/api/v1/imports').set('X-CSRF-Token', s.csrf).attach('file', Buffer.from(csv, 'utf8'), 'workr.csv');
            expect(up.status, JSON.stringify(up.body)).toBe(201);
            const id = up.body.import.id as string;
            const cfg = await s.agent.put(`/api/v1/imports/${id}/configuration`).set('X-CSRF-Token', s.csrf).send({
                mapping: [{ index: 0, target: 'name' }, { index: 1, target: 'email' }, { index: 2, target: 'phone' }],
                listName: 'WorkR - nurturing', ownerId: users.manager.publicId, sourceId: workr.id, duplicateMode: 'SKIP',
            });
            expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
            expect((await s.agent.post(`/api/v1/imports/${id}/start`).set('X-CSRF-Token', s.csrf)).status).toBe(202);
            await imports.process(id);
            expect(await db.lead.count()).toBe(2);
            const imported = await db.lead.findFirstOrThrow({ where: { email: { in: ['vsl55@example.com', 'VSL55@Example.com'] } } });

            await arrive(detailsEvent(55));
            await arrive(formEvent(55));
            await arrive(bookedEvent(55));

            expect(await db.lead.count()).toBe(2);
            const after = await db.lead.findUniqueOrThrow({
                where: { id: imported.id },
                include: { firstSource: true, formResponses: true, bookings: true, opportunities: true, listMembers: { include: { list: true } } },
            });
            expect(after).toMatchObject({ ownerId: users.manager.id, vslDepth: 'BOOKED', formScore: 72 });
            expect(after.firstSource.name).toBe('WorkR');
            expect(after.listMembers.map((m) => m.list.name)).toEqual(['WorkR - nurturing']);
            expect(after.formResponses).toHaveLength(1);
            expect(after.bookings).toHaveLength(1);
            expect(after.opportunities).toHaveLength(1);
            expect(after.opportunities[0].scheduledCallAt).not.toBeNull();
            const other = await db.lead.findFirstOrThrow({ where: { email: 'other@example.com' } });
            expect(other.vslDepth).toBe('NONE');
        });

        it('does not put an enrolled person back in the pipeline', async () => {
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'CSV import' } });
            const lead = await db.lead.create({
                data: {
                    fullName: 'Vsl Person 6', email: 'vsl6@example.com', phoneLast10: mobile(6), phoneE164: `+91${mobile(6)}`,
                    firstSourceId: source.id, capturedAt: new Date(), lifecycleStage: 'ENROLLED',
                    identities: { create: [{ type: 'EMAIL', value: 'vsl6@example.com' }] },
                },
            });
            await arrive(detailsEvent(6));
            expect(await db.opportunity.count({ where: { leadId: lead.id } })).toBe(0);
            expect(await db.touchpoint.count({ where: { leadId: lead.id } })).toBe(1);
        });

        it('opens a new opportunity for someone whose last one was lost and who comes back', async () => {
            await arrive(detailsEvent(1));
            const lead = await leadOf(1);
            await db.opportunity.updateMany({ where: { leadId: lead.id }, data: { status: 'LOST', openLeadId: null, closedAt: new Date() } });
            await arrive(formEvent(1));
            const opps = await db.opportunity.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
            expect(opps.map((o) => o.status)).toEqual(['LOST', 'OPEN']);
        });

        it('stops for a person to decide when the email and the phone belong to two leads', async () => {
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'CSV import' } });
            const make = (name: string, type: 'EMAIL' | 'PHONE', value: string) =>
                db.lead.create({ data: { fullName: name, firstSourceId: source.id, capturedAt: new Date(), ...(type === 'EMAIL' ? { email: value } : { phoneLast10: value }), identities: { create: [{ type, value }] } } });
            await make('Email owner', 'EMAIL', 'vsl1@example.com');
            await make('Phone owner', 'PHONE', mobile(1));
            const sent = await arrive(detailsEvent(1));
            expect(sent.row.status).toBe('DEAD');
            expect(sent.row.lastError).toContain('IDENTITY_CONFLICT');
            expect(await db.lead.count()).toBe(2);
        });
    });

    describe('after the leads arrive', () => {
        it('the manager sees them unassigned, ranked, and can give them to a BDA, who then sees them', async () => {
            await arrive(detailsEvent(1));
            await arrive(formEvent(2));
            await arrive(bookedEvent(3));
            const manager = await session('manager');
            const unassigned = await manager.agent.get('/api/v1/leads?view=unassigned');
            expect(unassigned.body.total).toBe(3);

            const bda = await session('bda1');
            expect((await bda.agent.get('/api/v1/leads')).body.total).toBe(0);

            const lead = await leadOf(3);
            const give = await manager.agent.post('/api/v1/assignment/bulk').set('X-CSRF-Token', manager.csrf).send({ leadIds: [lead.publicId], toUserId: users.bda1.publicId });
            expect(give.status, JSON.stringify(give.body)).toBe(200);
            expect(give.body.moved).toBe(1);
            const after = await leadOf(3);
            expect(after.ownerId).toBe(users.bda1.id);
            expect(after.opportunities[0].ownerId).toBe(users.bda1.id);
            expect((await bda.agent.get('/api/v1/leads')).body.total).toBe(1);
            const log = await db.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } });
            expect(log).toMatchObject({ fromUserId: null, toUserId: users.bda1.id, vslDepth: 'BOOKED' });
        });

        it('the lead page shows the VSL journey: answers, score and the booked call', async () => {
            await arrive(detailsEvent(1));
            await arrive(formEvent(1));
            await arrive(bookedEvent(1));
            const lead = await leadOf(1);
            const manager = await session('manager');
            const res = await manager.agent.get(`/api/v1/leads/${lead.publicId}`);
            expect(res.status).toBe(200);
            expect(res.body.vsl).toMatchObject({ depth: 'BOOKED', score: 72, temperature: 'WARM' });
            expect(res.body.vsl.forms[0].answers[0]).toEqual({ key: 'company', question: 'Current Company', answer: 'TCS' });
            expect(res.body.vsl.bookings[0]).toMatchObject({ slotLabel: '7 Nov 2026, 11:00 AM - 11:30 AM', status: 'CONFIRMED' });
            const titles = res.body.events.map((e: { title: string }) => e.title);
            expect(titles).toEqual(expect.arrayContaining(['Gave details on the VSL', 'Filled the qualification form', 'Booked a counselling call']));
        });

        it('a lead with no VSL history has no VSL block', async () => {
            const source = await db.leadSource.findFirstOrThrow({ where: { name: 'CSV import' } });
            const lead = await db.lead.create({ data: { fullName: 'Plain', email: 'plain@example.com', firstSourceId: source.id, capturedAt: new Date(), identities: { create: [{ type: 'EMAIL', value: 'plain@example.com' }] } } });
            const manager = await session('manager');
            expect((await manager.agent.get(`/api/v1/leads/${lead.publicId}`)).body.vsl).toBeNull();
        });

        it('the Intake monitor shows the VSL events with the right wording and source health', async () => {
            await arrive(detailsEvent(1));
            await arrive(formEvent(1));
            const admin = await session('admin');
            const events = (await admin.agent.get('/api/v1/intake/events')).body.events;
            expect(events[0]).toMatchObject({ source: 'VSL · candidate-form-details', event: 'vsl.form_submitted', status: 'Processed', detail: 'Vsl Person 1 (updated)' });
            expect(events[1]).toMatchObject({ event: 'vsl.details_submitted', detail: 'Vsl Person 1' });
            const summary = (await admin.agent.get('/api/v1/intake/summary')).body;
            expect(summary.sources.find((s: { id: string }) => s.id === 'VSL_FORM')).toMatchObject({ status: 'Healthy', today: 2 });
            expect(summary.sources.find((s: { id: string }) => s.id === 'VSL_BOOKING').status).toBe('Never');
        });
    });
    describe('alerts for the team', () => {
        const alertsOf = async (key: string) => (await db.notification.findMany({ where: { userId: users[key].id }, orderBy: { id: 'asc' } })).map((n) => [n.type, n.message]);
        let workr: { id: number };
        beforeEach(async () => {
            workr = await db.leadSource.findFirstOrThrow({ where: { name: 'WorkR' } });
        });

        it('tells the owner once when a nurturing lead comes back to the VSL, however many steps follow', async () => {
            await db.lead.create({
                data: {
                    fullName: 'Vsl Person 20', email: 'vsl20@example.com', phoneLast10: mobile(20), phoneE164: `+91${mobile(20)}`,
                    ownerId: users.bda1.id, firstSourceId: workr.id, capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'vsl20@example.com' }, { type: 'PHONE', value: mobile(20) }] },
                },
            });
            await arrive(detailsEvent(20));
            await arrive(formEvent(20));
            expect(await alertsOf('bda1')).toEqual([['LEAD_REENGAGED', 'A lead you are nurturing is back on the VSL']]);
            for (const other of ['bda2', 'manager', 'admin', 'closer', 'ops']) expect(await alertsOf(other)).toEqual([]);
            const lead = await leadOf(20);
            expect((await db.notification.findFirstOrThrow({ where: { userId: users.bda1.id } })).leadId).toBe(lead.id);
        });

        it('tells the managers when the returning lead has no owner', async () => {
            await db.lead.create({
                data: {
                    fullName: 'Vsl Person 21', email: 'vsl21@example.com', phoneLast10: mobile(21), phoneE164: `+91${mobile(21)}`,
                    ownerId: null, firstSourceId: workr.id, capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'vsl21@example.com' }, { type: 'PHONE', value: mobile(21) }] },
                },
            });
            await arrive(detailsEvent(21));
            for (const key of ['manager', 'admin', 'admin2']) expect(await alertsOf(key)).toEqual([['LEAD_REENGAGED', 'A lead with no owner is back on the VSL']]);
            for (const other of ['bda1', 'bda2', 'closer', 'ops']) expect(await alertsOf(other)).toEqual([]);
        });

        it('says nothing when a new person fills the VSL, or when a learner who is already enrolled does', async () => {
            await arrive(detailsEvent(22));
            await arrive(formEvent(22));
            await db.lead.create({
                data: {
                    fullName: 'Vsl Person 23', email: 'vsl23@example.com', phoneLast10: mobile(23), phoneE164: `+91${mobile(23)}`,
                    ownerId: users.bda1.id, lifecycleStage: 'ENROLLED', firstSourceId: workr.id, capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'vsl23@example.com' }, { type: 'PHONE', value: mobile(23) }] },
                },
            });
            await arrive(detailsEvent(23));
            await arrive(bookedEvent(23));
            expect(await db.notification.count({ where: { type: 'LEAD_REENGAGED' } })).toBe(0);
            // the new person's booking has no owner, but the learner's must not alert either
            expect(await db.notification.count({ where: { type: 'BOOKED_SLOT_UNASSIGNED' } })).toBe(0);
        });

        it('tells the owner when a lead they work books a call, once even if the event repeats', async () => {
            await db.lead.create({
                data: {
                    fullName: 'Vsl Person 24', email: 'vsl24@example.com', phoneLast10: mobile(24), phoneE164: `+91${mobile(24)}`,
                    ownerId: users.bda1.id, firstSourceId: workr.id, capturedAt: new Date(),
                    identities: { create: [{ type: 'EMAIL', value: 'vsl24@example.com' }, { type: 'PHONE', value: mobile(24) }] },
                },
            });
            await arrive(bookedEvent(24));
            await arrive(bookedEvent(24));
            expect(await alertsOf('bda1')).toEqual([['LEAD_REENGAGED', 'A lead you are working booked a call on the VSL']]);
            expect(await db.notification.count({ where: { type: 'BOOKED_SLOT_UNASSIGNED' } })).toBe(0);
        });

        it('tells every manager and admin when a call is booked and nobody owns the lead, once per booking', async () => {
            await arrive(detailsEvent(25));
            await arrive(bookedEvent(25));
            await arrive(bookedEvent(25));
            for (const key of ['manager', 'admin', 'admin2']) expect(await alertsOf(key)).toEqual([['BOOKED_SLOT_UNASSIGNED', 'A booked call has no owner yet']]);
            for (const other of ['bda1', 'bda2', 'closer', 'ops']) expect(await alertsOf(other)).toEqual([]);
            const lead = await leadOf(25);
            const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
            const row = await db.notification.findFirstOrThrow({ where: { userId: users.manager.id } });
            expect(row).toMatchObject({ leadId: lead.id, taskId: task.id });
        });
    });
    describe('when the VSL changes a booking', () => {
        const SLOT = new Date('2026-11-07T05:30:00Z');

        async function bookedLead(n: number) {
            await arrive(detailsEvent(n));
            await arrive(formEvent(n));
            await arrive(bookedEvent(n));
            return leadOf(n);
        }

        it('a cancelled booking cancels its task, clears the booked time and drops the lead back to what they did before', async () => {
            const before = await bookedLead(40);
            expect(before).toMatchObject({ vslDepth: 'BOOKED' });
            expect(before.opportunities[0]!.scheduledCallAt).toEqual(SLOT);

            const res = await arrive(cancelledEvent(40));
            expect(res.row.status).toBe('PROCESSED');
            const lead = await leadOf(40);
            expect(lead.bookings[0]).toMatchObject({ status: 'CANCELLED', cancelSource: 'candidate' });
            expect(lead.bookings[0]!.cancelledAt).toEqual(new Date('2026-11-06T09:00:00Z'));
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe('CANCELLED');
            expect(lead.opportunities[0]!.scheduledCallAt).toBeNull();
            expect(lead.vslDepth).toBe('FORM');
            expect(lead.priorityRank).toBeLessThan(before.priorityRank);
            expect(await timelineOf(lead.id)).toContain('BOOKING_CANCELLED');
        });

        it('says it once when the same cancellation comes twice, and leaves a call that was already held alone', async () => {
            const lead = await bookedLead(41);
            await arrive(cancelledEvent(41));
            await arrive({ ...cancelledEvent(41), eventId: 'vsl-cancelled-41-again' });
            expect((await timelineOf(lead.id)).filter((t) => t === 'BOOKING_CANCELLED')).toHaveLength(1);

            const held = await bookedLead(42);
            await arrive(completedEvent(42));
            await arrive(cancelledEvent(42));
            const after = await leadOf(42);
            expect(after.bookings[0]!.status).toBe('COMPLETED');
            expect(after.vslDepth).toBe('BOOKED');
            expect((await timelineOf(held.id)).filter((t) => t === 'BOOKING_CANCELLED')).toHaveLength(0);
        });

        it('keeps the lead booked when they still have another confirmed booking, and waits for a booking it has not seen', async () => {
            await arrive(detailsEvent(43));
            await arrive(bookedEvent(43));
            await arrive({ ...bookedEvent(43, { bookingId: '2043', slotStartAt: '2026-11-10T05:30:00Z', slotLabel: '10 Nov 2026, 11:00 AM - 11:30 AM' }, '2026-11-06T06:00:00Z'), eventId: 'vsl-booked-43-second' });
            await arrive(cancelledEvent(43));
            const lead = await leadOf(43);
            expect(lead.vslDepth).toBe('BOOKED');
            expect(lead.opportunities[0]!.scheduledCallAt).toEqual(new Date('2026-11-10T05:30:00Z'));

            const early = await arrive({ ...cancelledEvent(44), eventId: 'vsl-cancelled-early' });
            expect(early.row.status).toBe('FAILED');
            expect(early.row.lastError).toMatch(/has not reached the CRM/);
        });

        it('a rescheduled call moves the booking, the task, the booked time and the "starting soon" alert', async () => {
            const lead = await bookedLead(45);
            const task = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
            await db.notification.create({ data: { userId: users.bda1.id, type: 'SLOT_SOON', leadId: lead.id, taskId: task.id, message: 'A booked call starts at 11:00 AM' } });

            const res = await arrive(rescheduledEvent(45));
            expect(res.row.status).toBe('PROCESSED');
            const after = await leadOf(45);
            const moved = new Date('2026-11-09T09:30:00Z');
            expect(after.bookings[0]).toMatchObject({ status: 'CONFIRMED', slotStartAt: moved, slotLabel: '9 Nov 2026, 3:00 PM - 3:30 PM' });
            expect(after.opportunities[0]!.scheduledCallAt).toEqual(moved);
            const movedTask = await db.task.findFirstOrThrow({ where: { leadId: lead.id } });
            expect(movedTask).toMatchObject({ status: 'OPEN', dueAt: moved });
            expect(movedTask.title).toContain('9 Nov 2026, 3:00 PM');
            expect(await db.notification.count({ where: { taskId: task.id, type: 'SLOT_SOON' } })).toBe(0);
            expect((await timelineOf(lead.id)).filter((t) => t === 'BOOKING_RESCHEDULED')).toHaveLength(1);

            await arrive({ ...rescheduledEvent(45), eventId: 'vsl-rescheduled-45-again' });
            expect((await timelineOf(lead.id)).filter((t) => t === 'BOOKING_RESCHEDULED')).toHaveLength(1);
        });

        it('a call that was cancelled does not come back to life by being rescheduled', async () => {
            await bookedLead(46);
            await arrive(cancelledEvent(46));
            await arrive(rescheduledEvent(46));
            const lead = await leadOf(46);
            expect(lead.bookings[0]).toMatchObject({ status: 'CANCELLED', slotStartAt: SLOT });
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe('CANCELLED');
        });

        it('taking back "call done" puts the booking and its task back', async () => {
            const lead = await bookedLead(47);
            await arrive(completedEvent(47));
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe('DONE');

            const res = await arrive(reopenedEvent(47));
            expect(res.row.status).toBe('PROCESSED');
            const after = await leadOf(47);
            expect(after.bookings[0]).toMatchObject({ status: 'CONFIRMED', completedAt: null });
            expect(await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).toMatchObject({ status: 'OPEN', completedAt: null });
            expect(after.opportunities[0]!.scheduledCallAt).toEqual(SLOT);
            expect(await timelineOf(lead.id)).toContain('BOOKING_REOPENED');

            await arrive({ ...reopenedEvent(47), eventId: 'vsl-reopened-47-again' });
            expect((await timelineOf(lead.id)).filter((t) => t === 'BOOKING_REOPENED')).toHaveLength(1);
        });

        it('a "taken back" that is older than the latest "done" does not reopen the call', async () => {
            const lead = await bookedLead(48);
            await arrive(completedEvent(48, '2026-11-07T06:10:00Z'));
            const stale = { ...reopenedEvent(48), eventId: 'vsl-reopened-48-stale', payload: { bookingId: '1048', submissionId: SUB(48), reopenedAt: '2026-11-07T06:05:00Z' } };
            await arrive(stale);
            expect((await leadOf(48)).bookings[0]!.status).toBe('COMPLETED');
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe('DONE');
            const fresh = { ...reopenedEvent(48), eventId: 'vsl-reopened-48-fresh', payload: { bookingId: '1048', submissionId: SUB(48), reopenedAt: '2026-11-07T06:20:00Z' } };
            await arrive(fresh);
            expect((await leadOf(48)).bookings[0]!.status).toBe('CONFIRMED');
        });

        it('lets only the booking key send these events', async () => {
            const wrong = await send(formKey, cancelledEvent(1));
            expect(wrong.status).toBe(400);
            expect(wrong.body.code).toBe('EVENT_TYPE_NOT_ALLOWED');
            const bad = await send(bookingKey, { ...rescheduledEvent(1), payload: { bookingId: '1001' } });
            expect(bad.status).toBe(400);
        });
    });

    describe('the VSL header-score rule', () => {
        const entries = (leadId: bigint) => db.leadScoreEntry.findMany({ where: { leadId }, orderBy: { id: 'asc' } });
        // The VSL points wait until the team has tried the lead once; this is that first (unanswered) call.
        const tried = async (leadId: bigint) => {
            await db.activity.create({ data: { leadId, userId: users.bda1.id, kind: 'CALL', connected: false } });
            await app.get(ScoringService).scoreEvents([{ leadId, type: 'ACTIVITY_LOGGED', actorType: 'USER', data: { kind: 'CALL', connected: false } }] as never);
        };

        it("the lead's score carries the form's score on top of the points for giving details, each in the ledger", async () => {
            await arrive(detailsEvent(50));
            expect((await leadOf(50)).leadScore).toBe(0);
            await arrive(formEvent(50));
            expect((await leadOf(50)).leadScore).toBe(0);
            expect(await entries((await leadOf(50)).id)).toHaveLength(0);
            await tried((await leadOf(50)).id);
            const lead = await leadOf(50);
            expect(lead.leadScore).toBe(77);
            const rows = await entries(lead.id);
            expect(rows).toHaveLength(2);
            expect(rows[0]).toMatchObject({ points: 5, reason: 'VSL_DETAILS' });
            expect(rows[1]).toMatchObject({ points: 72, reason: 'VSL_FORM_SCORE' });
        });

        it('repeating the event changes nothing; a newer form replaces the score; an older one arriving late does not', async () => {
            await arrive(formEvent(51));
            await tried((await leadOf(51)).id);
            await arrive({ ...formEvent(51), eventId: 'vsl-form-51-again' });
            // 5 for coming in through the VSL page, 72 from the form.
            expect((await leadOf(51)).leadScore).toBe(77);

            const newer = formEvent(51, { submissionId: SUB(5100), score: 90, temperature: 'HOT', submittedAt: '2026-11-06T05:40:00Z' }, '2026-11-06T05:40:00Z');
            await arrive({ ...newer, eventId: 'vsl-form-51-newer' });
            let lead = await leadOf(51);
            expect(lead.leadScore).toBe(95);

            const older = formEvent(51, { submissionId: SUB(5101), score: 20, submittedAt: '2026-11-04T05:40:00Z' }, '2026-11-04T05:40:00Z');
            await arrive({ ...older, eventId: 'vsl-form-51-older' });
            lead = await leadOf(51);
            expect(lead.leadScore).toBe(95);
            const rows = await entries(lead.id);
            expect(rows.reduce((sum, r) => sum + r.points, 0)).toBe(95);
        });

        it('points given for other reasons stay on top, and a form without a score changes nothing', async () => {
            await arrive(detailsEvent(52));
            const lead = await leadOf(52);
            const leads = app.get(LeadsServiceForTest);
            await leads.addScore(lead.id, 5, 'MANUAL_TEST');
            await tried(lead.id);
            await arrive(formEvent(52));
            // 5 for the details, 5 given by hand, 72 from the form.
            expect((await leadOf(52)).leadScore).toBe(82);
            await arrive({ ...formEvent(52, { submissionId: SUB(5201), score: 60, submittedAt: '2026-11-06T05:40:00Z' }, '2026-11-06T05:40:00Z'), eventId: 'vsl-form-52-b' });
            expect((await leadOf(52)).leadScore).toBe(70);
            await arrive({ ...formEvent(52, { submissionId: SUB(5202), score: null, submittedAt: '2026-11-07T05:40:00Z' }, '2026-11-07T05:40:00Z'), eventId: 'vsl-form-52-c' });
            expect((await leadOf(52)).leadScore).toBe(70);
        });
    });

    describe('the nightly booked-call check', () => {
        const SLOT = new Date('2026-11-07T05:30:00Z');
        const before = new Date('2026-11-07T03:00:00Z');
        const reconciler = () => app.get(VslReconcileService);

        async function bookedLead(n: number) {
            await arrive(detailsEvent(n));
            await arrive(bookedEvent(n));
            return leadOf(n);
        }

        it('repairs a call whose task or booked time went missing, and does nothing when all agrees', async () => {
            const lead = await bookedLead(60);
            const clean = await reconciler().run(before);
            expect(clean).toMatchObject({ bookingsChecked: 1, tasksCreated: 0, tasksRetimed: 0, tasksClosed: 0, callsNeverMarkedDone: 0 });

            await db.task.deleteMany({ where: { leadId: lead.id } });
            await db.opportunity.updateMany({ where: { leadId: lead.id }, data: { scheduledCallAt: null } });
            const repaired = await reconciler().run(before);
            expect(repaired.tasksCreated).toBe(1);
            expect(await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).toMatchObject({ type: 'SCHEDULED_CALL', status: 'OPEN', dueAt: SLOT });
            expect((await leadOf(60)).opportunities[0]!.scheduledCallAt).toEqual(SLOT);

            const again = await reconciler().run(before);
            expect(again).toMatchObject({ tasksCreated: 0, tasksRetimed: 0, tasksClosed: 0 });
            expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
        });

        it('moves a task whose time is wrong, and closes the task of a booking the CRM knows is cancelled or done', async () => {
            const a = await bookedLead(61);
            await db.task.updateMany({ where: { leadId: a.id }, data: { dueAt: new Date('2026-11-01T00:00:00Z') } });
            const b = await bookedLead(62);
            await db.booking.updateMany({ where: { leadId: b.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
            const c = await bookedLead(63);
            await db.booking.updateMany({ where: { leadId: c.id }, data: { status: 'COMPLETED', completedAt: new Date() } });

            const report = await reconciler().run(before);
            expect(report).toMatchObject({ tasksRetimed: 1, tasksClosed: 2 });
            expect(await db.task.findFirstOrThrow({ where: { leadId: a.id } })).toMatchObject({ status: 'OPEN', dueAt: SLOT });
            expect((await db.task.findFirstOrThrow({ where: { leadId: b.id } })).status).toBe('CANCELLED');
            expect((await db.task.findFirstOrThrow({ where: { leadId: c.id } })).status).toBe('DONE');
            expect((await leadOf(62)).opportunities[0]!.scheduledCallAt).toBeNull();
            expect((await leadOf(62)).vslDepth).toBe('DETAILS');
        });

        it('leaves a task a person closed by hand, and reports a call nobody ever marked done', async () => {
            const lead = await bookedLead(64);
            await db.task.updateMany({ where: { leadId: lead.id }, data: { status: 'DONE', completedAt: new Date() } });
            const report = await reconciler().run(new Date('2026-11-12T00:00:00Z'));
            expect(report).toMatchObject({ tasksCreated: 0, tasksClosed: 0, callsNeverMarkedDone: 1 });
            expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe('DONE');
        });

        it('can be run by an admin or ops from the Intake monitor, and not by a BDA', async () => {
            await bookedLead(65);
            const admin = await session('admin');
            const ok = await admin.agent.post('/api/v1/intake/reconcile').set('X-CSRF-Token', admin.csrf);
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(ok.body).toMatchObject({ bookingsChecked: 1 });
            const ops = await session('ops');
            expect((await ops.agent.post('/api/v1/intake/reconcile').set('X-CSRF-Token', ops.csrf)).status).toBe(200);
            const bda = await session('bda1');
            expect((await bda.agent.post('/api/v1/intake/reconcile').set('X-CSRF-Token', bda.csrf)).status).toBe(403);
        });
    });
});
