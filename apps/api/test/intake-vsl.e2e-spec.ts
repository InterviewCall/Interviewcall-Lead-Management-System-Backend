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
import { IntakeService } from '../src/modules/intake/intake.service.js';
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
});
