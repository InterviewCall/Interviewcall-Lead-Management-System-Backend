/**
 * The CSV import engine against a REAL MySQL/MariaDB database: real repositories, real Prisma,
 * real unique indexes, real sign-in. Only Redis is faked (the queue is captured and the worker's
 * `process()` is called directly).
 *
 * It wipes every table, so it only runs when told to, against a database whose name ends in `_test`:
 *
 *   CRM_TEST_DB_HOST=127.0.0.1 CRM_TEST_DB_PORT=3306 CRM_TEST_DB_USER=... CRM_TEST_DB_PASSWORD=... \
 *   CRM_TEST_DB_NAME=crm_test npm run test:e2e -- imports-engine
 *
 * The database must already have the migrations applied (`prisma migrate deploy`).
 */
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ModelService } from '@app/model';
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from '@app/rate-limit';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { IMPORT_CHUNK_SIZE, IMPORTS_QUEUE } from '../src/modules/imports/imports.constants.js';
import { INTAKE_QUEUE } from '../src/modules/intake/intake.constants.js';
import { ImportsService } from '../src/modules/imports/imports.service.js';
import { LeadsService } from '../src/modules/leads/leads.service.js';
import { PipelineService } from '../src/modules/pipeline/pipeline.service.js';
import { NOTIFICATIONS_QUEUE } from '../src/notifications/notifications.constants.js';
import { cheapHash, signIn } from './support/create-test-app.js';

const env = process.env;
const enabled =
    Boolean(env.CRM_TEST_DB_HOST && env.CRM_TEST_DB_USER && env.CRM_TEST_DB_NAME) &&
    (env.CRM_TEST_DB_NAME ?? '').endsWith('_test');

const PASSWORD = 'test-password-123';
const mobile = (n: number) => `9${String(n).padStart(9, '0')}`;

describe.skipIf(!enabled)('import engine (real database)', () => {
    let app: INestApplication;
    let db: ModelService;
    let imports: ImportsService;
    const queue = {
        waitUntilReady: () => Promise.resolve(),
        add: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
    };

    // A fake clock for the rate limiter: every test starts a fresh window, so the limits themselves are not under test here.
    let clock = Date.now();
    beforeEach(() => {
        clock += 120_000;
    });

    let sourceId: number;
    let sources: Record<string, number>;
    const users: Record<string, { id: bigint; publicId: string; email: string }> = {};

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
            .useValue(queue)
            .overrideProvider(getQueueToken(INTAKE_QUEUE))
            .useValue({ waitUntilReady: () => Promise.resolve(), add: vi.fn(), close: vi.fn() })
            .compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(ModelService);
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
        await make('manager', 'Manager Mira', 'SALES_MANAGER');
        await make('bda1', 'BDA Bose', 'BDA');
        await make('bda2', 'BDA Rao', 'BDA');
        await make('closer', 'Closer Chen', 'CLOSER');
        await make('ops', 'Ops Omar', 'OPS');
        sources = {};
        for (const [name, group] of [['WorkR', 'WORKR'], ['Meta ads', 'META'], ['CSV import', 'IMPORT']] as const) {
            const s = await db.leadSource.create({ data: { name, group }, select: { id: true } });
            sources[name] = s.id;
        }
        sourceId = sources.WorkR;
    }, 60_000);

    afterAll(async () => {
        delete process.env.CRM_WEB_ORIGIN;
        await app?.close();
    });

    async function wipe() {
        const tables = await db.$queryRawUnsafe<{ TABLE_NAME: string }[]>(
            `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> '_prisma_migrations'`,
        );
        // One connection for all of it: the foreign-key switch belongs to the connection.
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const { TABLE_NAME } of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${TABLE_NAME}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
    }

    /** Removes every lead and what hangs off it, keeping staff, sources and settings. */
    async function clearLeadData() {
        const tables = [
            'import_rows', 'import_jobs', 'lead_list_members', 'lead_lists', 'lead_score_entries', 'lead_events', 'lead_assignments',
            'opportunity_stage_changes', 'opportunities', 'touchpoints', 'activities', 'tasks', 'bookings', 'form_responses', 'outcomes',
            'lead_identities', 'leads',
        ];
        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
            for (const t of tables) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
            await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        });
    }

    const session = (key: string) => signIn(app, users[key].email, PASSWORD);
    type Session = Awaited<ReturnType<typeof session>>;

    async function upload(s: Session, csv: string, name = 'leads.csv') {
        return s.agent.post('/api/v1/imports').set('X-CSRF-Token', s.csrf).attach('file', Buffer.from(csv, 'utf8'), name);
    }

    const baseConfig = (mapping: unknown[], over: Record<string, unknown> = {}) => ({
        mapping,
        listName: `List ${Math.random().toString(36).slice(2, 8)}`,
        ownerId: users.bda1.publicId,
        sourceId,
        duplicateMode: 'SKIP',
        ...over,
    });

    const configure = (s: Session, id: string, body: unknown) =>
        s.agent.put(`/api/v1/imports/${id}/configuration`).set('X-CSRF-Token', s.csrf).send(body as object);
    const post = (s: Session, path: string) => s.agent.post(`/api/v1/imports/${path}`).set('X-CSRF-Token', s.csrf);

    const STANDARD_MAPPING = [
        { index: 0, target: 'name' },
        { index: 1, target: 'email' },
        { index: 2, target: 'phone' },
        { index: 3, target: 'company' },
        { index: 4, target: 'leadScore' },
    ];
    const header = 'Full Name,Email Address,Mobile,Company,Lead Score';

    /** Upload, configure, start and run the worker. Returns the finished import. */
    async function runImport(
        s: Session,
        csv: string,
        over: Record<string, unknown> = {},
        mapping: unknown[] = STANDARD_MAPPING,
    ) {
        const up = await upload(s, csv);
        expect(up.status, JSON.stringify(up.body)).toBe(201);
        const id = up.body.import.id as string;
        const cfg = await configure(s, id, baseConfig(mapping, over));
        expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
        const start = await post(s, `${id}/start`);
        expect(start.status, JSON.stringify(start.body)).toBe(202);
        await imports.process(id);
        const done = await s.agent.get(`/api/v1/imports/${id}`);
        return { id, job: done.body.import, upload: up.body };
    }

    describe('access', () => {
        it('rejects a request with no session', async () => {
            await request(app.getHttpServer()).get('/api/v1/imports').expect(401);
            await request(app.getHttpServer()).get('/api/v1/imports/options').expect(401);
        });

        it.each(['bda1', 'closer', 'ops'])('closes every route to a %s', async (key) => {
            const s = await session(key);
            const id = '00000000-0000-4000-8000-000000000000';
            const probes: [string, () => Promise<request.Response>][] = [
                ['options', () => s.agent.get('/api/v1/imports/options')],
                ['list', () => s.agent.get('/api/v1/imports')],
                ['get', () => s.agent.get(`/api/v1/imports/${id}`)],
                ['rows', () => s.agent.get(`/api/v1/imports/${id}/rows`)],
                ['report', () => s.agent.get(`/api/v1/imports/${id}/report`)],
                ['upload', () => s.agent.post('/api/v1/imports').set('X-CSRF-Token', s.csrf)],
                ['configure', () => configure(s, id, baseConfig(STANDARD_MAPPING))],
                ['dry-run', () => post(s, `${id}/dry-run`)],
                ['start', () => post(s, `${id}/start`)],
                ['cancel', () => post(s, `${id}/cancel`)],
            ];
            for (const [name, send] of probes) {
                const response = await send();
                expect([name, response.status, response.body.code]).toEqual([name, 403, 'FORBIDDEN']);
            }
            expect(await db.importJob.count()).toBe(0);
        });

        it.each(['admin', 'manager'])('lets a %s in', async (key) => {
            const s = await session(key);
            const response = await s.agent.get('/api/v1/imports/options').expect(200);
            expect(response.body.owners.map((o: { name: string }) => o.name).sort()).toEqual([
                'BDA Bose', 'BDA Rao', 'Manager Mira',
            ]);
            expect(response.body.sources.map((x: { name: string }) => x.name)).toContain('WorkR');
            expect(response.body.startingStage).toEqual({ lifecycle: 'MARKETING_LEAD', opportunity: 'CALL_1_PENDING' });
            expect(response.body.limits.maxRows).toBe(25000);
        });
    });

    describe('upload and mapping', () => {
        it('reads the file, suggests a mapping and keeps every row', async () => {
            const s = await session('manager');
            const csv = `\uFEFFFull Name,Email Address,Mobile Number,Current Company,Notes\r\nRavi Kumar,ravi@x.com,98765 43210,Acme,vip\r\nAsha Rao,asha@x.com,+91 99999 88888,Beta,\r\n`;
            const response = await upload(s, csv, 'C:\\fakepath\\Naukri Nov.csv');
            expect(response.status, JSON.stringify(response.body)).toBe(201);
            expect(response.body.import).toMatchObject({
                fileName: 'Naukri Nov.csv',
                status: 'UPLOADED',
                headers: ['Full Name', 'Email Address', 'Mobile Number', 'Current Company', 'Notes'],
                counts: { total: 2, processed: 0, created: 0, matched: 0, skipped: 0, errors: 0 },
                createdBy: { name: 'Manager Mira' },
            });
            expect(response.body.preview.sample).toHaveLength(2);
            expect(response.body.preview.suggestedMapping.map((m: { target: string }) => m.target)).toEqual([
                'name', 'email', 'phone', 'company', 'skip',
            ]);
            const stored = await db.importRow.count({ where: { job: { publicId: response.body.import.id } } });
            expect(stored).toBe(2);
        });

        it('turns bad uploads into clear errors', async () => {
            const s = await session('admin');
            expect((await s.agent.post('/api/v1/imports').set('X-CSRF-Token', s.csrf)).body.code).toBe('FILE_REQUIRED');
            const notCsv = await upload(s, 'x', 'leads.xlsx');
            expect([notCsv.status, notCsv.body.code]).toEqual([400, 'UNSUPPORTED_FILE']);
            const empty = await upload(s, '   \n');
            expect([empty.status, empty.body.code]).toEqual([422, 'INVALID_CSV']);
            const noRows = await upload(s, 'Name,Email\n');
            expect([noRows.status, noRows.body.code]).toEqual([422, 'INVALID_CSV']);
            const unclosed = await upload(s, 'Name,Email\n"oops,1\n');
            expect(unclosed.body.message).toMatch(/never closed/);
            const big = await s.agent
                .post('/api/v1/imports')
                .set('X-CSRF-Token', s.csrf)
                .attach('file', Buffer.alloc(11 * 1024 * 1024, 'a'), 'big.csv');
            expect([big.status, big.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
            expect(await db.importJob.count({ where: { fileName: { in: ['leads.xlsx', 'big.csv'] } } })).toBe(0);
        });

        it('validates the configuration field by field', async () => {
            const s = await session('admin');
            const { body } = await upload(s, `${header}\nA,a@b.co,${mobile(2)},,`);
            const id = body.import.id as string;

            const noName = await configure(s, id, baseConfig([{ index: 1, target: 'email' }]));
            expect(noName.status).toBe(400);
            expect(noName.body.fields.mapping).toMatch(/Full name/);

            const noIdentity = await configure(s, id, baseConfig([{ index: 0, target: 'name' }]));
            expect(noIdentity.body.fields.mapping).toMatch(/Email or Phone/);

            const twice = await configure(s, id, baseConfig([...STANDARD_MAPPING, { index: 5, target: 'phone' }]));
            expect(twice.body.fields.mapping).toMatch(/not in the file/);

            const closerOwner = await configure(s, id, baseConfig(STANDARD_MAPPING, { ownerId: users.closer.publicId }));
            expect(closerOwner.body.fields.ownerId).toMatch(/BDA or sales manager/);

            const ghostOwner = await configure(s, id, baseConfig(STANDARD_MAPPING, { ownerId: '00000000-0000-4000-8000-000000000001' }));
            expect(ghostOwner.status).toBe(400);

            const noSource = await configure(s, id, baseConfig(STANDARD_MAPPING, { sourceId: 99999 }));
            expect(noSource.body.fields.sourceId).toMatch(/lead source/);

            const shortName = await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'x' }));
            expect(shortName.body.fields.listName).toMatch(/at least 2/);

            const extra = await configure(s, id, { ...baseConfig(STANDARD_MAPPING), status: 'DONE' });
            expect(extra.status).toBe(400);

            const ok = await configure(s, id, baseConfig(STANDARD_MAPPING, { ownerId: null }));
            expect(ok.status).toBe(200);
            expect(ok.body.import).toMatchObject({ status: 'MAPPED', owner: null, source: { name: 'WorkR' } });
        });
    });

    describe('importing', () => {
        it('creates unique leads at the first stage, owned, scored, listed and logged', async () => {
            const s = await session('manager');
            const csv = [
                header,
                `  Ravi   Kumar ,Ravi@Example.com,98765 43210,Acme,25`,
                `Asha Rao,asha@x.com,+91-99999-88888,Beta Corp,`,
                `Meera Iyer,,09876500001,,0`,
                `No Contact,,,,`,
                `Bad Email,nope,,,`,
                `,empty@name.com,${mobile(7)},,`,
                `Warn Row,warn@x.com,${mobile(8)},,high`,
            ].join('\n');
            const { id, job } = await runImport(s, csv, { listName: 'Naukri Nov batch', listDescription: 'Naukri export', note: 'sent by Priya' });

            expect(job.status).toBe('DONE');
            expect(job.counts).toEqual({ total: 7, processed: 7, created: 4, matched: 0, skipped: 0, errors: 3 });
            expect(job).toMatchObject({ listName: 'Naukri Nov batch', owner: { name: 'BDA Bose' }, note: 'sent by Priya' });
            expect(job.finishedAt).not.toBeNull();

            const leads = await db.lead.findMany({ orderBy: { id: 'asc' }, include: { identities: true, touchpoints: true, listMembers: true, scoreEntries: true } });
            expect(leads.map((l) => l.fullName)).toEqual(['Ravi Kumar', 'Asha Rao', 'Meera Iyer', 'Warn Row']);

            const ravi = leads[0];
            expect(ravi).toMatchObject({
                email: 'ravi@example.com',
                phoneE164: '+919876543210',
                phoneLast10: '9876543210',
                currentCompany: 'Acme',
                lifecycleStage: 'MARKETING_LEAD',
                ownerId: users.bda1.id,
                firstSourceId: sourceId,
                leadScore: 25,
            });
            expect(ravi.identities.map((i) => `${i.type}:${i.value}`).sort()).toEqual(['EMAIL:ravi@example.com', 'PHONE:9876543210']);
            expect(ravi.touchpoints).toHaveLength(1);
            expect(ravi.touchpoints[0]).toMatchObject({ kind: 'IMPORT', sourceId, externalRef: `import:${id}:1` });
            expect(ravi.scoreEntries).toHaveLength(1);
            expect(ravi.scoreEntries[0]).toMatchObject({ points: 25, reason: 'IMPORT_INITIAL' });
            expect(leads[1].scoreEntries).toHaveLength(0);
            expect(leads[2].leadScore).toBe(0);
            // A phone-only row has no email identity.
            expect(leads[2].identities.map((i) => i.type)).toEqual(['PHONE']);

            const list = await db.leadList.findUniqueOrThrow({ where: { name: 'Naukri Nov batch' }, include: { members: true } });
            expect(list.description).toBe('Naukri export');
            expect(list.members).toHaveLength(4);
            expect(list.createdById).toBe(users.manager.id);

            const opps = await db.opportunity.findMany({ include: { stageChanges: true } });
            expect(opps).toHaveLength(4);
            for (const o of opps) {
                expect(o).toMatchObject({ stage: 'CALL_1_PENDING', status: 'OPEN', ownerId: users.bda1.id });
                expect(o.openLeadId).toBe(o.leadId);
                expect(o.stageChanges).toHaveLength(1);
                expect(o.stageChanges[0]).toMatchObject({ fromStage: null, toStage: 'CALL_1_PENDING', changedById: users.manager.id });
            }

            const assignments = await db.leadAssignment.findMany();
            expect(assignments).toHaveLength(4);
            for (const a of assignments) {
                expect(a).toMatchObject({ method: 'IMPORT', toUserId: users.bda1.id, byUserId: users.manager.id, batchId: id, sourceId, vslDepth: 'NONE' });
            }

            const events = await db.leadEvent.findMany({ where: { leadId: ravi.id }, orderBy: { id: 'asc' } });
            expect(events.map((e) => e.type)).toEqual(['LEAD_CREATED', 'ASSIGNED', 'OPPORTUNITY_OPENED']);
            // The timeline holds ids and field names, never personal values.
            expect(JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/ravi|9876543210|Acme/i);

            const rows = await s.agent.get(`/api/v1/imports/${id}/rows?status=ERROR`).expect(200);
            expect(rows.body.rows.map((r: { message: string }) => r.message)).toEqual([
                'The row has no email or phone.',
                'Email is not valid.',
                'Name is missing.',
            ]);
            const warned = await db.importRow.findFirstOrThrow({ where: { job: { publicId: id }, rowNo: 7 } });
            expect(warned.status).toBe('CREATED');
            expect(warned.message).toMatch(/Lead score must be a whole number/);

            const audit = await db.auditLog.findMany({ where: { entityId: id }, orderBy: { id: 'asc' } });
            expect(audit.map((a) => a.action)).toEqual(['import.uploaded', 'import.started', 'import.completed']);
            expect(JSON.stringify(audit, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/ravi|asha|@/i);
        });

        it('leaves leads unassigned when no owner is chosen', async () => {
            const s = await session('admin');
            const { job } = await runImport(s, `${header}\nUn Owned,unowned@x.com,${mobile(100)},,`, { ownerId: null, listName: 'No owner list' });
            expect(job.counts.created).toBe(1);
            const lead = await db.lead.findFirstOrThrow({ where: { email: 'unowned@x.com' } });
            expect(lead.ownerId).toBeNull();
            expect(await db.leadAssignment.count({ where: { leadId: lead.id } })).toBe(0);
            const opp = await db.opportunity.findFirstOrThrow({ where: { leadId: lead.id } });
            expect([opp.stage, opp.ownerId]).toEqual(['CALL_1_PENDING', null]);
        });

        it('creates new fields from columns and stores their values', async () => {
            const s = await session('admin');
            const csv = `Name,Email,City,Current Domain\nCity Person,city@x.com,Pune,Backend\n`;
            const mapping = [
                { index: 0, target: 'name' },
                { index: 1, target: 'email' },
                { index: 2, target: 'custom', label: 'Current city' },
                { index: 3, target: 'domain' },
            ];
            const dry = await (async () => {
                const up = await upload(s, csv);
                await configure(s, up.body.import.id, baseConfig(mapping, { listName: 'Custom field list' }));
                return post(s, `${up.body.import.id}/dry-run`);
            })();
            expect(dry.body.newFields).toEqual(['Current city']);
            const { job } = await runImport(s, csv.replace('city@x.com', 'city2@x.com'), { listName: 'Custom field list 2' }, mapping);
            expect(job.counts.created).toBe(1);
            const def = await db.customFieldDefinition.findUniqueOrThrow({ where: { key: 'current_city' } });
            expect([def.label, def.type]).toEqual(['Current city', 'TEXT']);
            const lead = await db.lead.findFirstOrThrow({ where: { email: 'city2@x.com' } });
            expect(lead.custom).toEqual({ current_city: 'Pune' });
            expect(lead.domain).toBe('Backend');
        });
    });

    describe('duplicates', () => {
        const mappingWithCompany = STANDARD_MAPPING;

        it('never creates a second lead for the same person, however the email or phone is written', async () => {
            const s = await session('manager');
            await runImport(s, `${header}\nOriginal One,dup.one@x.com,${mobile(200)},Acme,10\nOriginal Two,dup.two@x.com,${mobile(201)},Beta,`, { listName: 'Seed list' });
            const before = await db.lead.count();

            const csv = [
                header,
                `Same By Email,DUP.ONE@X.COM,,,`, // email, different case
                `Same By Phone,,+91 ${mobile(201).slice(0, 5)} ${mobile(201).slice(5)},,`, // phone, formatted
                `Same By Zero Phone,,0${mobile(200)},,`,
                `Brand New,new.person@x.com,${mobile(202)},,5`,
                `Brand New Again,NEW.person@x.com,,,`, // repeats row 4 in the file by email
                `Brand New Phone Dup,,${mobile(202)},,`, // repeats row 4 by phone
            ].join('\n');
            const { id, job } = await runImport(s, csv, { listName: 'Overlap list' });

            expect(job.counts).toEqual({ total: 6, processed: 6, created: 1, matched: 5, skipped: 0, errors: 0 });
            expect(await db.lead.count()).toBe(before + 1);

            const rows = await db.importRow.findMany({ where: { job: { publicId: id } }, orderBy: { rowNo: 'asc' } });
            expect(rows.map((r) => [r.status, r.message])).toEqual([
                ['MATCHED', 'Already a lead (same email)'],
                ['MATCHED', 'Already a lead (same phone)'],
                ['MATCHED', 'Already a lead (same phone)'],
                ['CREATED', null],
                ['MATCHED', 'Repeated in this file (row 4, same email)'],
                ['MATCHED', 'Repeated in this file (row 4, same phone)'],
            ]);
            // The matched rows point at the lead that already existed.
            const one = await db.lead.findFirstOrThrow({ where: { email: 'dup.one@x.com' } });
            expect(rows[0].leadId).toBe(one.id);
            expect(rows[2].leadId).toBe(one.id);

            // Existing leads are untouched under SKIP, apart from a note that the person came in again.
            const reread = await db.lead.findUniqueOrThrow({ where: { id: one.id }, include: { touchpoints: true, listMembers: true } });
            expect(reread.fullName).toBe('Original One');
            expect(reread.leadScore).toBe(10);
            expect(reread.touchpoints).toHaveLength(3);
            expect(reread.touchpoints.filter((t) => (t.payload as { duplicate?: boolean }).duplicate)).toHaveLength(2);
            // Only leads the import created join its list.
            const list = await db.leadList.findUniqueOrThrow({ where: { name: 'Overlap list' }, include: { members: true } });
            expect(list.members).toHaveLength(1);
        });

        it('previews duplicates the same way (dry run), including the existing lead', async () => {
            const s = await session('manager');
            const csv = [
                header,
                `Dup Again,dup.one@x.com,,,`,
                `Fresh One,fresh.one@x.com,${mobile(300)},,`,
                `Fresh Repeat,fresh.one@x.com,,,`,
                `Broken,not-an-email,,,`,
                `Warn,warn.dry@x.com,${mobile(301)},,abc`,
            ].join('\n');
            const up = await upload(s, csv);
            await configure(s, up.body.import.id, baseConfig(mappingWithCompany, { listName: 'Dry run list' }));
            const dry = await post(s, `${up.body.import.id}/dry-run`).expect(200);
            expect(dry.body.summary).toEqual({ total: 5, new: 2, matched: 2, skipped: 0, errors: 1, warnings: 1 });
            expect(dry.body.truncated).toBe(false);
            const byRow = Object.fromEntries(dry.body.issues.map((i: { rowNo: number }) => [i.rowNo, i]));
            expect(byRow[1]).toMatchObject({ kind: 'MATCHED', message: 'Already a lead (same email)', existingLead: { name: 'Original One' } });
            expect(byRow[3]).toMatchObject({ kind: 'MATCHED', message: 'Repeated in this file (row 2, same email)', line: 4 });
            expect(byRow[4]).toMatchObject({ kind: 'ERROR', message: 'Email is not valid.' });
            expect(byRow[5].kind).toBe('WARNING');
            // A dry run writes nothing.
            expect(await db.lead.count({ where: { email: 'fresh.one@x.com' } })).toBe(0);
            expect(await db.leadList.count({ where: { name: 'Dry run list' } })).toBe(0);
        });

        it('fills only the empty fields of an existing lead when asked to, and never overwrites', async () => {
            const s = await session('manager');
            await runImport(s, `Name,Email,Phone,Company,CTC\nFill Target,fill@x.com,,Existing Co,\n`, { listName: 'Fill seed' }, [
                { index: 0, target: 'name' }, { index: 1, target: 'email' }, { index: 2, target: 'phone' }, { index: 3, target: 'company' }, { index: 4, target: 'ctc' },
            ]);
            const csv = `Name,Email,Phone,Company,CTC\nOther Name,fill@x.com,${mobile(400)},New Co,10-15 LPA\n`;
            const { job } = await runImport(s, csv, { listName: 'Fill list', duplicateMode: 'FILL_EMPTY' }, [
                { index: 0, target: 'name' }, { index: 1, target: 'email' }, { index: 2, target: 'phone' }, { index: 3, target: 'company' }, { index: 4, target: 'ctc' },
            ]);
            expect(job.counts).toMatchObject({ created: 0, matched: 1 });
            const lead = await db.lead.findFirstOrThrow({ where: { email: 'fill@x.com' }, include: { identities: true } });
            expect(lead).toMatchObject({ fullName: 'Fill Target', currentCompany: 'Existing Co', currentCtc: '10-15 LPA', phoneLast10: mobile(400) });
            expect(lead.identities.map((i) => i.type).sort()).toEqual(['EMAIL', 'PHONE']);
            const row = await db.importRow.findFirstOrThrow({ where: { job: { publicId: job.id } } });
            expect(row.message).toBe('Already a lead (same email); filled in currentCtc, phone');
            // The phone it gained now finds the lead too.
            const next = await runImport(s, `${header}\nAgain,,${mobile(400)},,\n`, { listName: 'Fill list 2' });
            expect(next.job.counts).toMatchObject({ created: 0, matched: 1 });
        });

        it('does not guess when the email and the phone belong to different leads', async () => {
            const s = await session('manager');
            await runImport(s, `${header}\nPerson A,conflict.a@x.com,${mobile(500)},,\nPerson B,conflict.b@x.com,${mobile(501)},,`, { listName: 'Conflict seed' });
            const before = await db.lead.count();
            const { id, job } = await runImport(s, `${header}\nMixed,conflict.a@x.com,${mobile(501)},,\n`, { listName: 'Conflict list' });
            expect(job.counts).toMatchObject({ created: 0, matched: 0, skipped: 1 });
            expect(await db.lead.count()).toBe(before);
            const row = await db.importRow.findFirstOrThrow({ where: { job: { publicId: id } } });
            expect([row.status, row.leadId]).toEqual(['SKIPPED', null]);
            expect(row.message).toMatch(/two different leads/);
        });

        it('keeps one lead when two imports race on the same people', async () => {
            const s = await session('admin');
            const people = Array.from({ length: 40 }, (_, i) => `Racer ${i},racer${i}@x.com,${mobile(6000 + i)},,`);
            const csv = [header, ...people].join('\n');
            const prepared = [];
            for (const name of ['Race A', 'Race B', 'Race C']) {
                const up = await upload(s, csv);
                const id = up.body.import.id as string;
                await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: name }));
                await post(s, `${id}/start`).expect(202);
                prepared.push(id);
            }
            await Promise.all(prepared.map((id) => imports.process(id)));

            expect(await db.lead.count({ where: { email: { startsWith: 'racer' } } })).toBe(40);
            expect(await db.leadIdentity.count({ where: { value: { startsWith: 'racer' } } })).toBe(40);
            const totals = await Promise.all(prepared.map((id) => db.importJob.findUniqueOrThrow({ where: { publicId: id } })));
            expect(totals.every((t) => t.status === 'DONE' && t.errorCount === 0)).toBe(true);
            expect(totals.reduce((sum, t) => sum + t.createdCount, 0)).toBe(40);
            expect(totals.reduce((sum, t) => sum + t.matchedCount, 0)).toBe(80);
            // Each lead has exactly one opportunity and one LEAD_CREATED event.
            expect(await db.opportunity.count({ where: { lead: { email: { startsWith: 'racer' } } } })).toBe(40);
            expect(await db.leadEvent.count({ where: { type: 'LEAD_CREATED', lead: { email: { startsWith: 'racer' } } } })).toBe(40);
        }, 60_000);
    });

    describe('lead score', () => {
        it('starts at the imported score and rises as the lead engages, with a ledger that adds up', async () => {
            const s = await session('manager');
            await runImport(s, `${header}\nScored Lead,scored@x.com,${mobile(700)},,15`, { listName: 'Score list' });
            const lead = await db.lead.findFirstOrThrow({ where: { email: 'scored@x.com' } });
            const leads = app.get(LeadsService);

            expect(await leads.addScore(lead.id, 10, 'CALL_CONNECTED', 'activity:1')).toBe(25);
            expect(await leads.addScore(lead.id, 5, 'FORM_SUBMITTED')).toBe(30);
            expect(await leads.addScore(lead.id, -8, 'NO_ANSWER_STREAK')).toBe(22);

            const entries = await db.leadScoreEntry.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
            expect(entries.map((e) => [e.reason, e.points])).toEqual([
                ['IMPORT_INITIAL', 15], ['CALL_CONNECTED', 10], ['FORM_SUBMITTED', 5], ['NO_ANSWER_STREAK', -8],
            ]);
            const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
            expect(stored.leadScore).toBe(entries.reduce((sum, e) => sum + e.points, 0));
            expect(stored.scoreUpdatedAt).not.toBeNull();

            // Several updates at once still add up.
            await Promise.all(Array.from({ length: 10 }, () => leads.addScore(lead.id, 1, 'CLICK')));
            expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).leadScore).toBe(32);
            await expect(leads.addScore(lead.id, 0, 'X')).rejects.toThrow(RangeError);
        });
    });

    describe('the job lifecycle', () => {
        it('refuses the wrong step in the wrong state', async () => {
            const s = await session('admin');
            const up = await upload(s, `${header}\nState Test,state@x.com,${mobile(800)},,`);
            const id = up.body.import.id as string;

            expect((await post(s, `${id}/start`)).body.code).toBe('IMPORT_NOT_READY');
            expect((await post(s, `${id}/dry-run`)).body.code).toBe('IMPORT_NOT_CONFIGURED');

            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'State list' })).then((r) => expect(r.status).toBe(200));
            await post(s, `${id}/start`).expect(202);
            expect((await post(s, `${id}/start`)).body.code).toBe('IMPORT_NOT_READY');
            const locked = await configure(s, id, baseConfig(STANDARD_MAPPING));
            expect([locked.status, locked.body.code]).toEqual([409, 'IMPORT_LOCKED']);
            expect((await post(s, `${id}/dry-run`)).body.code).toBe('IMPORT_NOT_CONFIGURED');

            await imports.process(id);
            const again = await post(s, `${id}/cancel`);
            expect([again.status, again.body.code]).toEqual([409, 'IMPORT_FINISHED']);
            // Processing a finished import does nothing.
            await imports.process(id);
            expect((await db.importJob.findUniqueOrThrow({ where: { publicId: id } })).createdCount).toBe(1);
        });

        it('does not let a list name be used twice, but lets the same import keep its own name', async () => {
            const s = await session('admin');
            await runImport(s, `${header}\nList One,list1@x.com,${mobile(900)},,`, { listName: 'Unique List' });
            const up = await upload(s, `${header}\nList Two,list2@x.com,${mobile(901)},,`);
            const id = up.body.import.id as string;
            for (const name of ['Unique List', 'unique list', '  UNIQUE LIST ']) {
                const taken = await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: name }));
                expect([taken.status, taken.body.code]).toEqual([409, 'LIST_NAME_TAKEN']);
            }
            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'Another List' })).then((r) => expect(r.status).toBe(200));
            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'Another List' })).then((r) => expect(r.status).toBe(200));
        });

        it('reverts to its previous state when the queue is down, and starts after a retry', async () => {
            const s = await session('admin');
            const up = await upload(s, `${header}\nQueue Test,queue@x.com,${mobile(1000)},,`);
            const id = up.body.import.id as string;
            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'Queue list' }));
            queue.add.mockRejectedValueOnce(new Error('redis down'));
            const down = await post(s, `${id}/start`);
            expect([down.status, down.body.code]).toEqual([503, 'QUEUE_UNAVAILABLE']);
            expect((await s.agent.get(`/api/v1/imports/${id}`)).body.import.status).toBe('MAPPED');
            // The list the first attempt made is reused, not reported as a name clash.
            await post(s, `${id}/start`).expect(202);
            expect(await db.leadList.count({ where: { name: 'Queue list' } })).toBe(1);
            expect(queue.add).toHaveBeenLastCalledWith('process', { importId: id }, expect.objectContaining({ attempts: 3 }));
        });

        it('stops when cancelled and keeps what it already created', async () => {
            const s = await session('admin');
            const people = Array.from({ length: 450 }, (_, i) => `Cancel ${i},cancel${i}@x.com,${mobile(20000 + i)},,`);
            const up = await upload(s, [header, ...people].join('\n'));
            const id = up.body.import.id as string;
            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'Cancel list' }));
            await post(s, `${id}/start`).expect(202);
            // Cancel part-way through the first chunk; the job stops once that chunk is done.
            const original = app.get(PipelineService).openOpportunity.bind(app.get(PipelineService));
            let seen = 0;
            const spy = vi.spyOn(app.get(PipelineService), 'openOpportunity').mockImplementation(async (input) => {
                seen++;
                if (seen === Math.floor(IMPORT_CHUNK_SIZE * 0.75)) await db.importJob.update({ where: { publicId: id }, data: { status: 'CANCELLED' } });
                return original(input);
            });
            await imports.process(id);
            spy.mockRestore();
            const job = await db.importJob.findUniqueOrThrow({ where: { publicId: id } });
            expect(job.status).toBe('CANCELLED');
            expect(job.processedCount).toBe(IMPORT_CHUNK_SIZE);
            expect(await db.lead.count({ where: { email: { startsWith: 'cancel' } } })).toBe(IMPORT_CHUNK_SIZE);
            expect(await db.importRow.count({ where: { jobId: job.id, status: null } })).toBe(450 - IMPORT_CHUNK_SIZE);
            expect(await db.importRow.count({ where: { jobId: job.id, status: 'CREATED' } })).toBe(IMPORT_CHUNK_SIZE);
        });

        it('cancels an import that has not started', async () => {
            const s = await session('manager');
            const up = await upload(s, `${header}\nNever Run,never@x.com,${mobile(1100)},,`);
            const id = up.body.import.id as string;
            const res = await post(s, `${id}/cancel`).expect(200);
            expect(res.body.import.status).toBe('CANCELLED');
            expect((await configure(s, id, baseConfig(STANDARD_MAPPING))).status).toBe(409);
            await imports.process(id);
            expect(await db.lead.count({ where: { email: 'never@x.com' } })).toBe(0);
        });
    });

    describe('crashes', () => {
        it('resumes after a failure without duplicating anything', async () => {
            const s = await session('manager');
            const csv = [header, ...Array.from({ length: 6 }, (_, i) => `Resume ${i},resume${i}@x.com,${mobile(30000 + i)},,`)].join('\n');
            const up = await upload(s, csv);
            const id = up.body.import.id as string;
            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'Resume list' }));
            await post(s, `${id}/start`).expect(202);

            // Row 3's lead is created, then the process "crashes" before its opportunity exists.
            const pipeline = app.get(PipelineService);
            const original = pipeline.openOpportunity.bind(pipeline);
            const spy = vi.spyOn(pipeline, 'openOpportunity').mockImplementation(async (input) => {
                const lead = await db.lead.findUniqueOrThrow({ where: { id: input.leadId } });
                if (lead.email === 'resume2@x.com') throw new Error('simulated crash');
                return original(input);
            });
            await expect(imports.process(id)).rejects.toThrow('1 rows could not be saved');
            spy.mockRestore();

            let job = await db.importJob.findUniqueOrThrow({ where: { publicId: id } });
            expect(job.status).toBe('RUNNING');
            expect(job.createdCount).toBe(5);
            expect(await db.lead.count({ where: { email: { startsWith: 'resume' } } })).toBe(6);
            expect(await db.opportunity.count({ where: { lead: { email: { startsWith: 'resume' } } } })).toBe(5);

            // The worker retries: only the unfinished row is touched, and it is finished properly.
            await imports.process(id);
            job = await db.importJob.findUniqueOrThrow({ where: { publicId: id } });
            expect(job).toMatchObject({ status: 'DONE', createdCount: 6, matchedCount: 0, errorCount: 0, processedCount: 6 });
            expect(await db.lead.count({ where: { email: { startsWith: 'resume' } } })).toBe(6);
            expect(await db.opportunity.count({ where: { lead: { email: { startsWith: 'resume' } } } })).toBe(6);
            expect(await db.leadAssignment.count({ where: { batchId: id } })).toBe(6);
            expect(await db.leadEvent.count({ where: { type: 'LEAD_CREATED', lead: { email: { startsWith: 'resume' } } } })).toBe(6);
            expect(await db.leadListMember.count({ where: { list: { name: 'Resume list' } } })).toBe(6);
        });

        it('stops early when the database keeps failing, marks the import failed and can be restarted', async () => {
            const s = await session('manager');
            const csv = [header, ...Array.from({ length: 30 }, (_, i) => `Outage ${i},outage${i}@x.com,${mobile(31000 + i)},,`)].join('\n');
            const up = await upload(s, csv);
            const id = up.body.import.id as string;
            await configure(s, id, baseConfig(STANDARD_MAPPING, { listName: 'Outage list' }));
            await post(s, `${id}/start`).expect(202);

            const leads = app.get(LeadsService);
            const spy = vi.spyOn(leads, 'importLead').mockRejectedValue(new Error('connection lost'));
            await expect(imports.process(id)).rejects.toThrow('connection lost');
            spy.mockRestore();
            // Only five rows were tried before it gave up, and none were marked as errors.
            expect(await db.importRow.count({ where: { job: { publicId: id }, status: null } })).toBe(30);

            await imports.markFailed(id, 'The import stopped before it finished.');
            const failed = (await s.agent.get(`/api/v1/imports/${id}`)).body.import;
            expect([failed.status, failed.failureReason]).toEqual(['FAILED', 'The import stopped before it finished.']);

            await post(s, `${id}/start`).expect(202);
            await imports.process(id);
            const done = (await s.agent.get(`/api/v1/imports/${id}`)).body.import;
            expect(done.status).toBe('DONE');
            expect(done.failureReason).toBeNull();
            expect(done.counts).toMatchObject({ created: 30, errors: 0 });
        });
    });

    describe('history and report', () => {
        it('lists imports newest first, pages rows and downloads a report with a status per row', async () => {
            const s = await session('admin');
            const csv = `${header}\nGood Row,report.good@x.com,${mobile(1200)},"Acme, Inc",5\nBad Row,not-valid,,,\nDup Row,report.good@x.com,,,\n=cmd|' /C calc'!A0,report.evil@x.com,,,\n`;
            const { id } = await runImport(s, csv, { listName: 'Report list' });

            const list = await s.agent.get('/api/v1/imports?pageSize=1').expect(200);
            expect(list.body.imports[0].id).toBe(id);
            expect(list.body.total).toBeGreaterThan(5);

            const page = await s.agent.get(`/api/v1/imports/${id}/rows?pageSize=2&page=2`).expect(200);
            expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 4 });
            expect(page.body.rows.map((r: { rowNo: number }) => r.rowNo)).toEqual([3, 4]);

            const report = await s.agent.get(`/api/v1/imports/${id}/report`).buffer(true).parse((res, cb) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (data += c));
                res.on('end', () => cb(null, data));
            });
            expect(report.status).toBe(200);
            expect(report.headers['content-type']).toMatch(/text\/csv/);
            expect(report.headers['content-disposition']).toMatch(/attachment; filename="import-[0-9a-f]{8}-report\.csv"/);
            const lines = (report.body as string).replace(/^\uFEFF/, '').trim().split('\r\n');
            expect(lines[0]).toBe(`${header},ImportStatus,ImportMessage`);
            expect(lines[1]).toBe('Good Row,report.good@x.com,9000001200,"Acme, Inc",5,Imported,');
            expect(lines[2]).toBe('Bad Row,not-valid,,,,Error,Email is not valid.');
            expect(lines[3]).toBe('Dup Row,report.good@x.com,,,,Duplicate,"Repeated in this file (row 1, same email)"');
            // A name that starts like a spreadsheet formula cannot run when the report is opened.
            expect(lines[4].startsWith(`"'=cmd`) || lines[4].startsWith(`'=cmd`)).toBe(true);
            expect((await db.auditLog.count({ where: { action: 'import.report_downloaded', entityId: id } }))).toBe(1);
        });

        it('404s for an unknown import and 400s for a malformed id', async () => {
            const s = await session('admin');
            const missing = await s.agent.get('/api/v1/imports/00000000-0000-4000-8000-0000000000ff');
            expect([missing.status, missing.body.code]).toEqual([404, 'IMPORT_NOT_FOUND']);
            expect((await s.agent.get('/api/v1/imports/not-a-uuid')).status).toBe(400);
        });
    });

    describe('volume', () => {
        it('imports 3,000 leads with duplicates in under a minute', async () => {
            const s = await session('admin');
            const rows = Array.from({ length: 3000 }, (_, i) => `Bulk ${i},bulk${i % 2800}@x.com,${mobile(100000 + (i % 2800))},Co ${i % 50},${i % 7}`);
            const started = Date.now();
            const { job } = await runImport(s, [header, ...rows].join('\n'), { listName: 'Bulk list' });
            const seconds = (Date.now() - started) / 1000;
            console.log(`3,000 rows imported in ${seconds.toFixed(1)}s`);
            expect(job.counts).toEqual({ total: 3000, processed: 3000, created: 2800, matched: 200, skipped: 0, errors: 0 });
            expect(await db.lead.count({ where: { email: { startsWith: 'bulk' } } })).toBe(2800);
            expect(seconds).toBeLessThan(60);
        }, 120_000);
    });

    describe('reading the imported leads', () => {
        let aList: string;
        let leadOfBda1: string;
        let leadOfBda2: string;

        beforeAll(async () => {
            // Earlier tests (the volume run above) leave leads behind; these tests count every lead, so start from none.
            await clearLeadData();
            const m = await session('manager');
            const people = (prefix: string, n: number, base: number) =>
                [header, ...Array.from({ length: n }, (_, i) => `${prefix} ${i},${prefix.toLowerCase()}${i}@read.com,${mobile(base + i)},Acme,${10 + i}`)].join('\n');
            const a = await runImport(m, people('Reader', 3, 910000), { listName: 'Read list A', ownerId: users.bda1.publicId, sourceId: sources['CSV import'] });
            await runImport(m, people('Other', 2, 920000), { listName: 'Read list B', ownerId: users.bda2.publicId, sourceId: sources.WorkR });
            await runImport(m, people('Loose', 1, 930000), { listName: 'Read list C', ownerId: null, sourceId: sources['CSV import'] });
            aList = (await db.leadList.findFirstOrThrow({ where: { name: 'Read list A' } })).publicId;
            expect(a.job.counts.created).toBe(3);
            leadOfBda1 = (await db.lead.findFirstOrThrow({ where: { email: 'reader0@read.com' } })).publicId;
            leadOfBda2 = (await db.lead.findFirstOrThrow({ where: { email: 'other0@read.com' } })).publicId;
        }, 60_000);

        const names = (body: { leads: { name: string }[] }) => body.leads.map((l) => l.name).sort();

        it('needs a session and a valid id', async () => {
            await request(app.getHttpServer()).get('/api/v1/leads').expect(401);
            const s = await session('manager');
            await s.agent.get('/api/v1/leads/not-a-uuid').expect(400);
            const missing = await s.agent.get('/api/v1/leads/00000000-0000-4000-8000-000000000000').expect(404);
            expect(missing.body.code).toBe('LEAD_NOT_FOUND');
            await s.agent.get('/api/v1/leads?pageSize=1000').expect(400);
        });

        it('shows managers, admins and ops every lead, with the view counts', async () => {
            for (const key of ['manager', 'admin', 'ops']) {
                const s = await session(key);
                const res = await s.agent.get('/api/v1/leads?pageSize=100').expect(200);
                expect(res.body.total).toBe(6);
                expect(res.body.counts).toMatchObject({ all: 6, unassigned: 1, mine: 0 });
            }
        });

        it('shows a BDA only their own leads, and counts only those', async () => {
            const s = await session('bda1');
            const res = await s.agent.get('/api/v1/leads').expect(200);
            expect(names(res.body)).toEqual(['Reader 0', 'Reader 1', 'Reader 2']);
            expect(res.body.counts).toMatchObject({ all: 3, mine: 3, unassigned: 0 });
            // Asking for somebody else's leads does not get past the scope.
            const other = await s.agent.get(`/api/v1/leads?ownerId=${users.bda2.publicId}`).expect(200);
            expect(other.body.total).toBe(0);
            const unassigned = await s.agent.get('/api/v1/leads?view=unassigned').expect(200);
            expect(unassigned.body.total).toBe(0);
            await s.agent.get(`/api/v1/leads/${leadOfBda2}`).expect(404);
            await s.agent.get(`/api/v1/leads/${leadOfBda1}`).expect(200);
        });

        it('shows a closer the leads that have an open opportunity', async () => {
            const s = await session('closer');
            expect((await s.agent.get('/api/v1/leads').expect(200)).body.total).toBe(6);
            await db.opportunity.updateMany({ where: { lead: { email: 'loose0@read.com' } }, data: { status: 'LOST', openLeadId: null } });
            expect((await s.agent.get('/api/v1/leads').expect(200)).body.total).toBe(5);
            await s.agent.get(`/api/v1/leads/${(await db.lead.findFirstOrThrow({ where: { email: 'loose0@read.com' } })).publicId}`).expect(404);
            await db.opportunity.updateMany({ where: { lead: { email: 'loose0@read.com' } }, data: { status: 'OPEN', openLeadId: (await db.lead.findFirstOrThrow({ where: { email: 'loose0@read.com' } })).id } });
        });

        it('searches by name, email and part of a phone number', async () => {
            const s = await session('manager');
            expect(names((await s.agent.get('/api/v1/leads?search=reader 1').expect(200)).body)).toEqual(['Reader 1']);
            expect(names((await s.agent.get('/api/v1/leads?search=OTHER1@READ').expect(200)).body)).toEqual(['Other 1']);
            expect(names((await s.agent.get(`/api/v1/leads?search=${mobile(930000).slice(-6)}`).expect(200)).body)).toEqual(['Loose 0']);
            expect((await s.agent.get('/api/v1/leads?search=nobody-here').expect(200)).body.total).toBe(0);
        });

        it('filters by source, stage, owner, list and view, and pages the results', async () => {
            const s = await session('manager');
            const get = async (q: string) => (await s.agent.get(`/api/v1/leads?${q}`).expect(200)).body;
            expect((await get(`sourceId=${sources.WorkR}`)).total).toBe(2);
            expect((await get('stage=CALL_1_PENDING')).total).toBe(6);
            expect((await get('stage=CALL_2')).total).toBe(0);
            expect(names(await get(`ownerId=${users.bda2.publicId}`))).toEqual(['Other 0', 'Other 1']);
            expect((await get('ownerId=none')).total).toBe(1);
            expect((await get(`listId=${aList}`)).total).toBe(3);
            expect((await get('view=unassigned')).total).toBe(1);
            expect((await get('view=hot')).total).toBe(0);
            const page1 = await get('pageSize=4&page=1');
            const page2 = await get('pageSize=4&page=2');
            expect([page1.leads.length, page2.leads.length, page1.total]).toEqual([4, 2, 6]);
            expect(new Set([...page1.leads, ...page2.leads].map((l: { id: string }) => l.id)).size).toBe(6);
        });

        it('describes a lead: score, list, stage and a readable timeline', async () => {
            const s = await session('manager');
            const res = await s.agent.get(`/api/v1/leads/${leadOfBda1}`).expect(200);
            expect(res.body.lead).toMatchObject({
                name: 'Reader 0', email: 'reader0@read.com', source: 'CSV import', stage: 'CALL_1_PENDING',
                lifecycle: 'MARKETING_LEAD', score: 10, company: 'Acme', owner: { name: 'BDA Bose' },
                lists: [{ name: 'Read list A' }],
            });
            expect(res.body.lead.phone).toMatch(/^\+91/);
            expect(res.body.scoreEntries).toEqual([expect.objectContaining({ points: 10, reason: 'IMPORT_INITIAL' })]);
            expect(res.body.opportunity).toMatchObject({ stage: 'CALL_1_PENDING', status: 'OPEN' });
            const titles = res.body.events.map((e: { title: string }) => e.title);
            expect(titles).toEqual(expect.arrayContaining(['Lead created from a CSV import', 'Assigned to BDA Bose', 'Opportunity opened at Call 1 Pending']));
            const created = res.body.events.find((e: { type: string }) => e.type === 'LEAD_CREATED');
            expect(created.sub).toBe('Added to the list “Read list A” by Manager Mira');
            // The response never carries internal numeric ids.
            expect(JSON.stringify(res.body)).not.toMatch(/"id":\d/);
        });

        it('offers the filters: active sources, lists and owners', async () => {
            const m = await session('manager');
            const all = await m.agent.get('/api/v1/leads/filters').expect(200);
            expect(all.body.lists.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(['Read list A', 'Read list B']));
            expect(all.body.owners.map((o: { name: string }) => o.name)).toEqual(['BDA Bose', 'BDA Rao']);
            const b = await session('bda1');
            const mine = await b.agent.get('/api/v1/leads/filters').expect(200);
            expect(mine.body.owners).toEqual([]);
            expect(mine.body.lists.find((l: { name: string; members: number }) => l.name === 'Read list B').members).toBe(0);
        });
    });

    describe('marking leads', () => {
        let mine: string;
        let other: string;
        let reasonId: number;
        const url = (id: string, tail: string) => `/api/v1/leads/${id}${tail}`;
        const csrf = (s: Session) => ({ 'X-CSRF-Token': s.csrf });
        const stage = (s: Session, id: string, to: string) => s.agent.post(url(id, '/opportunity/stage')).set(csrf(s)).send({ stage: to });
        const contact = (s: Session, id: string, to: string) => s.agent.post(url(id, '/contact-stage')).set(csrf(s)).send({ stage: to });

        beforeAll(async () => {
            await clearLeadData();
            await db.lostReason.createMany({
                data: [{ name: 'Wrong Number', sortOrder: 0 }, { name: 'Fresher', sortOrder: 1 }],
                skipDuplicates: true,
            });
            reasonId = (await db.lostReason.findFirstOrThrow({ where: { name: 'Fresher' } })).id;
            const m = await session('manager');
            const people = (prefix: string, n: number, base: number) =>
                [header, ...Array.from({ length: n }, (_, i) => `${prefix} ${i},${prefix.toLowerCase()}${i}@mark.com,${mobile(base + i)},Acme,${10 + i}`)].join('\n');
            await runImport(m, people('Mark', 3, 940000), { listName: 'Mark list', ownerId: users.bda1.publicId, sourceId: sources['CSV import'] });
            await runImport(m, people('Elsewhere', 1, 950000), { listName: 'Elsewhere list', ownerId: users.bda2.publicId, sourceId: sources.WorkR });
            mine = (await db.lead.findFirstOrThrow({ where: { email: 'mark0@mark.com' } })).publicId;
            other = (await db.lead.findFirstOrThrow({ where: { email: 'elsewhere0@mark.com' } })).publicId;
        }, 60_000);

        it('needs a session, a valid body, and an allowed role', async () => {
            await request(app.getHttpServer()).post(url(mine, '/contact-stage')).send({ stage: 'PROSPECT' }).expect(401);
            const m = await session('manager');
            await contact(m, mine, 'NOPE').expect(400);
            await stage(m, mine, 'NOPE').expect(400);
            const ops = await session('ops');
            await stage(ops, mine, 'CALL_1').expect(403);
            await contact(ops, mine, 'PROSPECT').expect(403);
        });

        it('marks the contact stage, records it on the timeline, and filters by it', async () => {
            const b = await session('bda1');
            const res = await contact(b, mine, 'PROSPECT').expect(200);
            expect(res.body.lead.lifecycle).toBe('PROSPECT');
            expect(res.body.events[0]).toMatchObject({ type: 'CONTACT_STAGE_CHANGED', title: 'Contact stage changed to Prospect', sub: 'From Marketing Lead by BDA Bose' });
            // Marking the same stage again changes nothing and adds no event.
            const again = await contact(b, mine, 'PROSPECT').expect(200);
            expect(again.body.events.filter((e: { type: string }) => e.type === 'CONTACT_STAGE_CHANGED')).toHaveLength(1);
            const m = await session('manager');
            const filtered = await m.agent.get('/api/v1/leads?lifecycle=PROSPECT').expect(200);
            expect(filtered.body.leads.map((l: { name: string }) => l.name)).toEqual(['Mark 0']);
            await m.agent.get('/api/v1/leads?lifecycle=BOGUS').expect(400);
        });

        it('keeps a BDA to their own leads', async () => {
            const b = await session('bda1');
            const res = await contact(b, other, 'PROSPECT').expect(404);
            expect(res.body.code).toBe('LEAD_NOT_FOUND');
            await stage(b, other, 'CALL_1').expect(404);
        });

        it('applies the handbook rules for Enrolled and Learner Onboarded', async () => {
            const m = await session('manager');
            const enrolled = await contact(m, mine, 'ENROLLED').expect(409);
            expect(enrolled.body.code).toBe('ENROLL_VIA_CLOSED_WON');
            const early = await contact(m, mine, 'LEARNER_ONBOARDED').expect(409);
            expect(early.body.code).toBe('ONBOARD_AFTER_ENROLLED');
        });

        it('moves the opportunity between stages, forwards and back, and records each move', async () => {
            const b = await session('bda1');
            const fwd = await stage(b, mine, 'TEST').expect(200);
            expect(fwd.body.opportunity).toMatchObject({ stage: 'TEST', status: 'OPEN' });
            expect(fwd.body.events[0]).toMatchObject({ type: 'OPPORTUNITY_STAGE_CHANGED', title: 'Moved to Test', sub: 'From Call 1 Pending by BDA Bose' });
            const back = await stage(b, mine, 'CALL_1').expect(200);
            expect(back.body.opportunity.stage).toBe('CALL_1');
            const changes = await db.opportunityStageChange.count({ where: { opportunity: { lead: { publicId: mine } } } });
            expect(changes).toBe(3); // opened, forward, back
            const m = await session('manager');
            expect((await m.agent.get('/api/v1/leads?stage=CALL_1').expect(200)).body.leads.map((l: { name: string }) => l.name)).toEqual(['Mark 0']);
        });

        it('lets only a closer or manager close as won, and that makes the lead Enrolled', async () => {
            const b = await session('bda1');
            const refused = await stage(b, mine, 'CLOSED_WON').expect(403);
            expect(refused.body.code).toBe('CLOSE_NOT_ALLOWED');
            const c = await session('closer');
            const won = await stage(c, mine, 'CLOSED_WON').expect(200);
            expect(won.body.opportunity).toMatchObject({ stage: 'CLOSED_WON', status: 'WON' });
            expect(won.body.lead.lifecycle).toBe('ENROLLED');
            expect(won.body.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['OPPORTUNITY_WON', 'CONTACT_STAGE_CHANGED']));
            // The lead leaves a closer's list once nothing is open, so they get the same answer as for any lead they cannot open.
            await stage(c, mine, 'CALL_1').expect(404);
            const m = await session('manager');
            // A won opportunity is closed: it cannot be moved or marked lost.
            expect((await stage(m, mine, 'CALL_1').expect(409)).body.code).toBe('NO_OPEN_OPPORTUNITY');
            // Learner Onboarded now follows; a BDA may not, a manager may. Going back is for managers only.
            await contact(b, mine, 'LEARNER_ONBOARDED').expect(403);
            expect((await contact(m, mine, 'LEARNER_ONBOARDED').expect(200)).body.lead.lifecycle).toBe('LEARNER_ONBOARDED');
            await contact(b, mine, 'PROSPECT').expect(403);
            // A manager can correct a stage that was set by mistake.
            expect((await contact(m, mine, 'ENGAGED_LEAD').expect(200)).body.lead.lifecycle).toBe('ENGAGED_LEAD');
        });

        it('marks a lead lost with a reason, then reopens it', async () => {
            const b = await session('bda1');
            const lead = (await db.lead.findFirstOrThrow({ where: { email: 'mark1@mark.com' } })).publicId;
            await b.agent.post(url(lead, '/opportunity/lost')).set(csrf(b)).send({ reasonId: 999999 }).expect(400);
            await b.agent.post(url(lead, '/opportunity/lost')).set(csrf(b)).send({}).expect(400);
            const lost = await b.agent.post(url(lead, '/opportunity/lost')).set(csrf(b)).send({ reasonId, note: 'Final-year student' }).expect(200);
            expect(lost.body.opportunity).toMatchObject({ status: 'LOST', stage: 'CALL_1_PENDING', lostReason: 'Fresher', lostNote: 'Final-year student' });
            expect(lost.body.events[0]).toMatchObject({ type: 'OPPORTUNITY_LOST', title: 'Marked lost: Fresher' });
            // The note is free text, so the timeline does not carry it.
            expect(JSON.stringify(lost.body.events)).not.toContain('Final-year');
            expect((await stage(b, lead, 'CALL_1').expect(409)).body.code).toBe('NO_OPEN_OPPORTUNITY');
            const reopened = await b.agent.post(url(lead, '/opportunity/reopen')).set(csrf(b)).expect(200);
            expect(reopened.body.opportunity).toMatchObject({ stage: 'CALL_1_PENDING', status: 'OPEN' });
            expect((await b.agent.post(url(lead, '/opportunity/reopen')).set(csrf(b)).expect(409)).body.code).toBe('ALREADY_OPEN');
        });

        it('lists the lost reasons for the pickers', async () => {
            const b = await session('bda1');
            const res = await b.agent.get('/api/v1/pipeline/lost-reasons').expect(200);
            expect(res.body.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['Wrong Number', 'Fresher']));
        });
    });
});
