import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthContext, Role } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { AssignmentService } from '@modules/assignment';
import { IamService, type StaffRef } from '@modules/iam';
import {
    type IdentityKind,
    identityKeysOf,
    identityMapKey,
    LeadsService,
} from '@modules/leads';
import { FIRST_STAGE, PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import {
    CSV_LIMITS,
    CsvError,
    csvLine,
    decodeCsvBytes,
    parseCsv,
} from './csv/csv-parser.js';
import {
    type ColumnMapping,
    IMPORT_FIELDS,
    suggestMapping,
    validateMapping,
} from './import-fields.js';
import {
    DRY_RUN_ISSUE_LIMIT,
    IMPORT_CHUNK_SIZE,
    MAX_CONSECUTIVE_ROW_FAILURES,
} from './imports.constants.js';
import { ImportsQueue } from './imports.queue.js';
import { ImportsRepository } from './imports.repository.js';
import type {
    ConfigureImportBody,
    ListImportsQuery,
    ListRowsQuery,
} from './imports.schemas.js';
import type {
    DryRunIssue,
    DryRunResult,
    ImportJobRecord,
    ImportRowRecord,
    ImportRowStatusName,
    ImportRowView,
    ImportView,
    RowResult,
} from './imports.types.js';
import { duplicateMessage } from './match-reason.js';
import { evaluateRow, resolveMapping, type ResolvedMapping } from './row-normalizer.js';

/** Only these roles may import leads. Checked on the route and again here. */
export const IMPORT_ROLES: readonly Role[] = ['ADMIN', 'SALES_MANAGER'];

/** Roles a lead can be given to on import: a BDA, or the manager. */
const OWNER_ROLES: Role[] = ['BDA', 'SALES_MANAGER'];

export interface UploadedCsv {
    originalname: string;
    size: number;
    buffer: Buffer;
}

interface RequestMeta {
    ip?: string | null;
}

const originRefOf = (publicId: string) => `import:${publicId}`;

function cleanFileName(raw: string): string {
    const base = raw.split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    return cleaned === '' ? 'import.csv' : cleaned;
}

@Injectable()
export class ImportsService {
    private readonly logger = new Logger(ImportsService.name);

    constructor(
        private readonly repository: ImportsRepository,
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly assignment: AssignmentService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly admin: AdminService,
        private readonly queue: ImportsQueue,
    ) {}

    // ------------------------------------------------------------------ access

    /** Defence in depth: the route already limits this to admins and sales managers. */
    private assertCanImport(auth: AuthContext): void {
        if (!IMPORT_ROLES.includes(auth.role)) {
            throw new ForbiddenException({
                code: 'FORBIDDEN',
                message: 'Only admins and sales managers can import leads',
            });
        }
    }

    private async actorOf(auth: AuthContext): Promise<StaffRef> {
        this.assertCanImport(auth);
        const actor = await this.iam.getStaffRef(auth.publicId);
        if (!actor || !actor.isActive) {
            throw new ForbiddenException({
                code: 'FORBIDDEN',
                message: 'This account cannot import leads',
            });
        }
        return actor;
    }

    private async jobOf(publicId: string): Promise<ImportJobRecord> {
        const job = await this.repository.findByPublicId(publicId);
        if (!job) {
            throw new NotFoundException({
                code: 'IMPORT_NOT_FOUND',
                message: 'Import not found',
            });
        }
        return job;
    }

    // ------------------------------------------------------------------ reading

    private toView(job: ImportJobRecord): ImportView {
        return {
            id: job.publicId,
            fileName: job.fileName,
            fileSize: job.fileSize,
            status: job.status,
            headers: job.headers,
            mapping: job.columnMapping,
            listName: job.listName,
            listDescription: job.listDescription,
            listId: job.list?.publicId ?? null,
            owner: job.owner ? { id: job.owner.publicId, name: job.owner.name } : null,
            source: job.source,
            duplicateMode: job.duplicateMode,
            note: job.note,
            counts: {
                total: job.totalRows,
                processed: job.processedCount,
                created: job.createdCount,
                matched: job.matchedCount,
                skipped: job.skippedCount,
                errors: job.errorCount,
            },
            failureReason: job.failureReason,
            createdBy: { id: job.createdBy.publicId, name: job.createdBy.name },
            createdAt: job.createdAt.toISOString(),
            startedAt: job.startedAt?.toISOString() ?? null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
        };
    }

    /** What the import form needs to fill its pickers. */
    async options(auth: AuthContext) {
        this.assertCanImport(auth);
        const [sources, owners, customFields] = await Promise.all([
            this.leads.listSources(),
            this.iam.listActiveStaff(OWNER_ROLES),
            this.leads.listCustomFields(),
        ]);
        return {
            sources,
            owners: owners.map((o) => ({ id: o.publicId, name: o.name, role: o.role })),
            fields: IMPORT_FIELDS.map(({ key, label, description }) => ({ key, label, description })),
            customFields,
            limits: {
                maxRows: CSV_LIMITS.maxRows,
                maxFileBytes: CSV_LIMITS.maxFileBytes,
                maxColumns: CSV_LIMITS.maxColumns,
            },
            // Where every imported lead starts.
            startingStage: { lifecycle: 'MARKETING_LEAD', opportunity: FIRST_STAGE },
        };
    }

    async list(auth: AuthContext, query: ListImportsQuery) {
        this.assertCanImport(auth);
        const { jobs, total } = await this.repository.list({
            status: query.status,
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
        });
        return {
            imports: jobs.map((j) => this.toView(j)),
            page: query.page,
            pageSize: query.pageSize,
            total,
        };
    }

    async get(auth: AuthContext, publicId: string): Promise<{ import: ImportView }> {
        this.assertCanImport(auth);
        return { import: this.toView(await this.jobOf(publicId)) };
    }

    async rows(
        auth: AuthContext,
        publicId: string,
        query: ListRowsQuery,
    ): Promise<{ rows: ImportRowView[]; page: number; pageSize: number; total: number }> {
        this.assertCanImport(auth);
        const job = await this.jobOf(publicId);
        const { rows, total } = await this.repository.rowsPage(job.id, {
            status: query.status,
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
        });
        return {
            rows: rows.map((r) => this.toRowView(r)),
            page: query.page,
            pageSize: query.pageSize,
            total,
        };
    }

    private toRowView(row: ImportRowRecord): ImportRowView {
        return {
            rowNo: row.rowNo,
            line: row.raw.line,
            status: row.status ?? 'PENDING',
            message: row.message,
            cells: row.raw.cells,
        };
    }

    // ------------------------------------------------------------------ steps 1-4

    /** Step 1: read the file, keep every row, and suggest a column mapping. */
    async createFromUpload(
        auth: AuthContext,
        file: UploadedCsv | undefined,
        meta: RequestMeta = {},
    ) {
        const actor = await this.actorOf(auth);
        if (!file) {
            throw new BadRequestException({
                code: 'FILE_REQUIRED',
                message: 'Choose a CSV file to upload',
                fields: { file: 'Choose a CSV file to upload' },
            });
        }
        const fileName = cleanFileName(file.originalname);
        if (!/\.csv$/i.test(fileName)) {
            throw new BadRequestException({
                code: 'UNSUPPORTED_FILE',
                message: 'Only .csv files are supported. In Excel or Sheets, choose Save as CSV and upload that.',
                fields: { file: 'Only .csv files are supported' },
            });
        }

        let parsed;
        try {
            parsed = parseCsv(decodeCsvBytes(file.buffer));
        } catch (error) {
            if (error instanceof CsvError) {
                throw new UnprocessableEntityException({
                    code: 'INVALID_CSV',
                    message: error.message,
                    fields: { file: error.message },
                });
            }
            throw error;
        }

        const job = await this.repository.createWithRows(
            {
                createdById: actor.id,
                fileName,
                fileSize: file.size,
                headers: parsed.headers,
            },
            parsed.rows.map((r) => ({ line: r.line, cells: r.cells })),
        );
        await this.admin.audit({
            action: AuditAction.ImportUploaded,
            actorId: actor.id,
            entityType: 'import_job',
            entityId: job.publicId,
            detail: { rows: parsed.rows.length, columns: parsed.headers.length },
            ip: meta.ip ?? null,
        });

        const customFields = await this.leads.listCustomFields();
        return {
            import: this.toView(job),
            preview: {
                delimiter: parsed.delimiter,
                sample: parsed.rows.slice(0, 5).map((r) => r.cells),
                suggestedMapping: suggestMapping(parsed.headers, customFields),
            },
        };
    }

    private badField(field: string, message: string): BadRequestException {
        return new BadRequestException({
            code: 'VALIDATION_FAILED',
            message,
            fields: { [field]: message },
        });
    }

    /** The source and owner must still be usable when the import is set up and again when it starts. */
    private async checkSourceAndOwner(
        sourceId: number,
        ownerId: string | null,
    ): Promise<{ owner: StaffRef | null }> {
        const source = await this.leads.findActiveSource(sourceId);
        if (!source) throw this.badField('sourceId', 'Choose an active lead source');
        if (ownerId === null) return { owner: null };
        const owner = await this.iam.getStaffRef(ownerId);
        if (!owner || !owner.isActive || !OWNER_ROLES.includes(owner.role)) {
            throw this.badField('ownerId', 'Choose an active BDA or sales manager as the owner');
        }
        return { owner };
    }

    /** Step 2: the column mapping, list name, source, owner and what to do with duplicates. */
    async configure(
        auth: AuthContext,
        publicId: string,
        body: ConfigureImportBody,
    ): Promise<{ import: ImportView }> {
        await this.actorOf(auth);
        const job = await this.jobOf(publicId);
        if (job.status !== 'UPLOADED' && job.status !== 'MAPPED') {
            throw new ConflictException({
                code: 'IMPORT_LOCKED',
                message: 'This import has already started and can no longer be changed',
            });
        }

        const mapping: ColumnMapping[] = body.mapping.map((c) => ({
            index: c.index,
            target: c.target,
            ...(c.target === 'custom' ? { label: (c.label ?? '').trim() } : {}),
        }));
        const problems = validateMapping(mapping, job.headers.length);
        if (problems.length > 0) {
            throw new BadRequestException({
                code: 'VALIDATION_FAILED',
                message: problems[0],
                fields: { mapping: problems.join(' ') },
            });
        }
        const { owner } = await this.checkSourceAndOwner(body.sourceId, body.ownerId);
        if (!(await this.leads.isListNameFree(body.listName, originRefOf(job.publicId)))) {
            throw new ConflictException({
                code: 'LIST_NAME_TAKEN',
                message: 'A list with this name already exists. Choose another name.',
                fields: { listName: 'A list with this name already exists' },
            });
        }

        const saved = await this.repository.saveConfiguration(job.id, {
            sourceId: body.sourceId,
            ownerId: owner?.id ?? null,
            listName: body.listName,
            listDescription: body.listDescription,
            note: body.note,
            duplicateMode: body.duplicateMode,
            columnMapping: mapping,
        });
        if (!saved) {
            throw new ConflictException({
                code: 'IMPORT_LOCKED',
                message: 'This import has already started and can no longer be changed',
            });
        }
        return { import: this.toView(await this.jobOf(publicId)) };
    }

    /**
     * Step 3: shows what would happen to every row, without writing anything. Rows are checked
     * the same way the import checks them, against the leads that exist right now.
     */
    async dryRun(auth: AuthContext, publicId: string): Promise<DryRunResult> {
        await this.actorOf(auth);
        const job = await this.jobOf(publicId);
        if (job.status !== 'MAPPED' || !job.columnMapping) {
            throw new ConflictException({
                code: 'IMPORT_NOT_CONFIGURED',
                message: 'Set up the column mapping, list, source and owner first',
            });
        }
        const mapping = resolveMapping(job.columnMapping);

        const summary = { total: job.totalRows, new: 0, matched: 0, skipped: 0, errors: 0, warnings: 0 };
        const hard: DryRunIssue[] = []; // errors and skipped rows
        const soft: DryRunIssue[] = []; // duplicates and warnings
        let dropped = false;
        const push = (list: DryRunIssue[], limit: number, issue: DryRunIssue) => {
            if (list.length < limit) list.push(issue);
            else dropped = true;
        };
        const hardLimit = Math.ceil(DRY_RUN_ISSUE_LIMIT * 0.6);
        const softLimit = DRY_RUN_ISSUE_LIMIT - hardLimit;

        // Identities of rows that would create a lead, so a repeat later in the file is seen as a duplicate.
        const inFile = new Map<string, number>();
        let cursor = 0;
        for (;;) {
            const rows = await this.repository.readRows(job.id, { afterRowNo: cursor, limit: 1_000 });
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1].rowNo;

            const evaluations = rows.map((row) => evaluateRow(row.raw.cells, mapping));
            const keys = evaluations.flatMap((e) => (e.ok ? identityKeysOf(e.lead) : []));
            const existing = await this.leads.findMatches(keys);

            rows.forEach((row, i) => {
                const evaluation = evaluations[i];
                const at = { rowNo: row.rowNo, line: row.raw.line };
                if (!evaluation.ok) {
                    summary.errors++;
                    push(hard, hardLimit, { ...at, kind: 'ERROR', message: evaluation.error });
                    return;
                }
                const rowKeys = identityKeysOf(evaluation.lead);
                const hits = new Map<
                    string,
                    { lead?: { id: string; name: string }; fileRow?: number; on: IdentityKind[] }
                >();
                for (const key of rowKeys) {
                    const found = existing.get(identityMapKey(key));
                    if (found) {
                        const hit = hits.get(`lead:${found.leadId}`) ?? {
                            lead: { id: found.publicId, name: found.fullName },
                            on: [],
                        };
                        hit.on.push(key.type);
                        hits.set(`lead:${found.leadId}`, hit);
                        continue;
                    }
                    const earlier = inFile.get(identityMapKey(key));
                    if (earlier !== undefined) {
                        const hit = hits.get(`row:${earlier}`) ?? { fileRow: earlier, on: [] };
                        hit.on.push(key.type);
                        hits.set(`row:${earlier}`, hit);
                    }
                }
                if (hits.size > 1) {
                    summary.skipped++;
                    push(hard, hardLimit, { ...at, kind: 'SKIPPED', message: CONFLICT_MESSAGE });
                } else if (hits.size === 1) {
                    const [hit] = [...hits.values()];
                    summary.matched++;
                    push(soft, softLimit, {
                        ...at,
                        kind: 'MATCHED',
                        message: duplicateMessage(hit.fileRow ?? null, hit.on),
                        ...(hit.lead ? { existingLead: hit.lead } : {}),
                    });
                } else {
                    summary.new++;
                    for (const key of rowKeys) inFile.set(identityMapKey(key), row.rowNo);
                    if (evaluation.warnings.length > 0) {
                        summary.warnings++;
                        push(soft, softLimit, { ...at, kind: 'WARNING', message: evaluation.warnings.join(' ') });
                    }
                }
            });
        }

        const existingFields = new Set((await this.leads.listCustomFields()).map((f) => f.key));
        const newFields = mapping.custom
            .filter((c) => !existingFields.has(c.key))
            .map((c) => c.label);

        return {
            summary,
            issues: [...hard, ...soft].sort((a, b) => a.rowNo - b.rowNo),
            truncated: dropped,
            newFields,
        };
    }

    /**
     * Step 4: makes the list, queues the job and returns at once. The worker does the rest; the
     * page watches progress with GET /imports/:id. A failed import can be started again and picks
     * up the rows it had not done.
     */
    async start(
        auth: AuthContext,
        publicId: string,
        meta: RequestMeta = {},
    ): Promise<{ import: ImportView }> {
        const actor = await this.actorOf(auth);
        const job = await this.jobOf(publicId);
        if (job.status !== 'MAPPED' && job.status !== 'FAILED') {
            throw new ConflictException({
                code: 'IMPORT_NOT_READY',
                message:
                    job.status === 'UPLOADED'
                        ? 'Set up the column mapping, list, source and owner first'
                        : 'This import has already started',
            });
        }
        if (!job.columnMapping || job.sourceId === null || job.listName === null) {
            throw new ConflictException({
                code: 'IMPORT_NOT_CONFIGURED',
                message: 'Set up the column mapping, list, source and owner first',
            });
        }
        await this.checkSourceAndOwner(job.sourceId, job.owner?.publicId ?? null);

        const mapping = resolveMapping(job.columnMapping);
        const list = await this.leads.createList({
            name: job.listName,
            description: job.listDescription,
            originRef: originRefOf(job.publicId),
            createdById: actor.id,
        });
        await this.leads.ensureCustomFields(mapping.custom.map((c) => ({ key: c.key, label: c.label })));

        const previous = job.status;
        const queued = await this.repository.transition(job.id, [previous], 'QUEUED', {
            listId: list.id,
            failureReason: null,
            finishedAt: null,
        });
        if (!queued) {
            throw new ConflictException({
                code: 'IMPORT_NOT_READY',
                message: 'This import has already started',
            });
        }
        try {
            await this.queue.enqueue(job.publicId);
        } catch (error) {
            this.logger.error(`Could not queue import ${job.publicId}: ${error instanceof Error ? error.message : 'unknown error'}`);
            await this.repository.transition(job.id, ['QUEUED'], previous);
            throw new ServiceUnavailableException({
                code: 'QUEUE_UNAVAILABLE',
                message: 'The import could not be started right now. Try again in a moment.',
            });
        }
        await this.admin.audit({
            action: AuditAction.ImportStarted,
            actorId: actor.id,
            entityType: 'import_job',
            entityId: job.publicId,
            detail: { rows: job.totalRows, duplicateMode: job.duplicateMode, resumed: previous === 'FAILED' },
            ip: meta.ip ?? null,
        });
        return { import: this.toView(await this.jobOf(publicId)) };
    }

    /**
     * Stops an import that has not finished. Leads it has already created stay (it never deletes
     * leads); the rows it had not reached are not processed.
     */
    async cancel(
        auth: AuthContext,
        publicId: string,
        meta: RequestMeta = {},
    ): Promise<{ import: ImportView }> {
        const actor = await this.actorOf(auth);
        const job = await this.jobOf(publicId);
        const stopped = await this.repository.transition(
            job.id,
            ['UPLOADED', 'MAPPED', 'QUEUED', 'RUNNING', 'FAILED'],
            'CANCELLED',
            { finishedAt: new Date() },
        );
        if (!stopped) {
            throw new ConflictException({
                code: 'IMPORT_FINISHED',
                message: 'This import has already finished',
            });
        }
        await this.repository.syncCounters(job.id);
        await this.admin.audit({
            action: AuditAction.ImportCancelled,
            actorId: actor.id,
            entityType: 'import_job',
            entityId: job.publicId,
            detail: { wasStatus: job.status },
            ip: meta.ip ?? null,
        });
        return { import: this.toView(await this.jobOf(publicId)) };
    }

    // ------------------------------------------------------------------ report

    /** The original file with two columns added, ImportStatus and ImportMessage: what happened to each row. */
    async report(
        auth: AuthContext,
        publicId: string,
        meta: RequestMeta = {},
    ): Promise<{ fileName: string; csv: string }> {
        const actor = await this.actorOf(auth);
        const job = await this.jobOf(publicId);
        const lines = [csvLine([...job.headers, 'ImportStatus', 'ImportMessage'])];
        let cursor = 0;
        for (;;) {
            const rows = await this.repository.readRows(job.id, { afterRowNo: cursor, limit: 2_000 });
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1].rowNo;
            for (const row of rows) {
                lines.push(csvLine([...row.raw.cells, REPORT_STATUS[row.status ?? 'PENDING'], row.message ?? '']));
            }
        }
        await this.admin.audit({
            action: AuditAction.ImportReportDownloaded,
            actorId: actor.id,
            entityType: 'import_job',
            entityId: job.publicId,
            detail: { rows: job.totalRows },
            ip: meta.ip ?? null,
        });
        // A byte order mark makes Excel read the file as UTF-8.
        return { fileName: `import-${job.publicId.slice(0, 8)}-report.csv`, csv: `﻿${lines.join('\r\n')}\r\n` };
    }

    // ------------------------------------------------------------------ the worker

    /**
     * Runs an import. Called by the worker. It can be called again for the same import after a
     * crash: it only touches rows that have not been processed, and each step of a row is safe to
     * repeat.
     */
    async process(publicId: string): Promise<void> {
        const job = await this.repository.findByPublicId(publicId);
        if (!job) {
            this.logger.warn(`Import ${publicId} no longer exists`);
            return;
        }
        if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return;
        if (!job.columnMapping || job.sourceId === null || !job.list) {
            await this.markFailed(publicId, 'The import was not fully set up');
            return;
        }
        await this.repository.transition(job.id, ['QUEUED'], 'RUNNING', { startedAt: new Date() });

        const context: RunContext = {
            job,
            mapping: resolveMapping(job.columnMapping),
            sourceId: job.sourceId,
            listId: job.list.publicId,
            listNumericId: job.listId!,
        };

        let cursor = 0;
        let consecutiveFailures = 0;
        let unfinished = 0;
        for (;;) {
            const rows = await this.repository.readRows(job.id, {
                afterRowNo: cursor,
                limit: IMPORT_CHUNK_SIZE,
                pendingOnly: true,
            });
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1].rowNo;

            for (const row of rows) {
                try {
                    const result = await this.processRow(context, row);
                    await this.repository.markRow(job.id, row.rowNo, result);
                    consecutiveFailures = 0;
                } catch (error) {
                    // Not the row's fault (a lost connection, a full disk). The row stays pending so a
                    // retry picks it up, and a run of these stops the job instead of burning through the file.
                    unfinished++;
                    consecutiveFailures++;
                    this.logger.error(
                        `Import ${publicId} row ${row.rowNo} failed: ${error instanceof Error ? error.name : 'unknown error'}`,
                    );
                    if (consecutiveFailures >= MAX_CONSECUTIVE_ROW_FAILURES) {
                        await this.repository.syncCounters(job.id);
                        throw error;
                    }
                }
            }
            await this.repository.syncCounters(job.id);

            const current = await this.repository.findByPublicId(publicId);
            if (current?.status === 'CANCELLED') return;
        }

        await this.repository.syncCounters(job.id);
        if (unfinished > 0) {
            throw new Error(`${unfinished} rows could not be saved`);
        }
        const done = await this.repository.transition(job.id, ['RUNNING'], 'DONE', { finishedAt: new Date() });
        if (!done) return; // cancelled while the last chunk ran
        const finished = await this.jobOf(publicId);
        await this.admin.audit({
            action: AuditAction.ImportCompleted,
            actorId: null,
            entityType: 'import_job',
            entityId: publicId,
            detail: {
                rows: finished.totalRows,
                created: finished.createdCount,
                matched: finished.matchedCount,
                skipped: finished.skippedCount,
                errors: finished.errorCount,
            },
        });
    }

    /** Ends a job that cannot continue. The rows already done are kept and a restart resumes the rest. */
    async markFailed(publicId: string, reason: string): Promise<void> {
        const job = await this.repository.findByPublicId(publicId);
        if (!job) return;
        const failed = await this.repository.transition(job.id, ['QUEUED', 'RUNNING'], 'FAILED', {
            failureReason: reason.slice(0, 255),
            finishedAt: new Date(),
        });
        if (!failed) return;
        await this.repository.syncCounters(job.id);
        await this.admin.audit({
            action: AuditAction.ImportFailed,
            actorId: null,
            entityType: 'import_job',
            entityId: publicId,
            detail: { reason: reason.slice(0, 120) },
        });
    }

    /** One row: check it, find out whether the person is already a lead, and create or skip. */
    private async processRow(context: RunContext, row: ImportRowRecord): Promise<RowResult> {
        const { job } = context;
        const evaluation = evaluateRow(row.raw.cells, context.mapping);
        if (!evaluation.ok) return { status: 'ERROR', leadId: null, message: evaluation.error };

        const { lead, warnings } = evaluation;
        const outcome = await this.leads.importLead({
            fields: {
                fullName: lead.fullName,
                email: lead.email,
                phoneE164: lead.phoneE164,
                phoneLast10: lead.phoneLast10,
                currentCompany: lead.currentCompany,
                currentCtc: lead.currentCtc,
                graduationYear: lead.graduationYear,
                domain: lead.domain,
                userType: lead.userType,
                custom: lead.custom,
            },
            sourceId: context.sourceId,
            ownerId: job.owner?.id ?? null,
            listId: context.listNumericId,
            ref: `import:${job.publicId}:${row.rowNo}`,
            handling: job.duplicateMode,
            initialScore: lead.leadScore,
            touchpointPayload: {
                importJob: job.publicId,
                row: row.rowNo,
                list: job.listName,
                ...(lead.sourceDetail ? { sourceDetail: lead.sourceDetail } : {}),
            },
        });

        if (outcome.kind === 'CONFLICT') {
            return { status: 'SKIPPED', leadId: null, message: CONFLICT_MESSAGE };
        }

        if (outcome.kind === 'MATCHED') {
            if (!outcome.resumed) {
                await this.timeline.append({
                    leadId: outcome.match.leadId,
                    type: TimelineEvent.TouchpointAdded,
                    actorType: 'USER',
                    actorId: job.createdBy.id,
                    data: { importJob: job.publicId, sourceId: context.sourceId },
                });
            }
            const createdBy = await this.repository.findRowNoThatCreated(job.id, outcome.match.leadId);
            let message = duplicateMessage(
                createdBy !== null && createdBy < row.rowNo ? createdBy : null,
                outcome.matchedOn,
            );
            if (outcome.filled.length > 0) message += `; filled in ${outcome.filled.join(', ')}`;
            return { status: 'MATCHED', leadId: outcome.match.leadId, message };
        }

        // A new lead. Everything after the lead itself is safe to repeat, so a retried row finishes the job.
        const leadId = outcome.leadId;
        const opportunity = await this.pipeline.openOpportunity({
            leadId,
            ownerId: job.owner?.id ?? null,
            actorId: job.createdBy.id,
        });
        const actor = { actorType: 'USER', actorId: job.createdBy.id } as const;
        const events = [
            {
                leadId,
                type: TimelineEvent.LeadCreated,
                ...actor,
                data: { importJob: job.publicId, sourceId: context.sourceId, list: context.listId },
            },
            ...(job.owner
                ? [{ leadId, type: TimelineEvent.Assigned, ...actor, data: { to: job.owner.publicId, method: 'IMPORT' } }]
                : []),
            {
                leadId,
                type: TimelineEvent.OpportunityOpened,
                ...actor,
                data: { stage: FIRST_STAGE, opportunity: opportunity.publicId },
            },
        ];
        if (job.owner) {
            await this.assignment.recordImportAssignment(
                {
                    leadId,
                    toUserId: job.owner.id,
                    byUserId: job.createdBy.id,
                    sourceId: context.sourceId,
                    batchId: job.publicId,
                },
                { mayExist: outcome.resumed },
            );
        }
        if (outcome.resumed) {
            // An earlier attempt may have written some of these already.
            for (const event of events) await this.timeline.appendOnce(event);
        } else {
            await this.timeline.appendMany(events);
        }
        return { status: 'CREATED', leadId, message: warnings.length > 0 ? warnings.join(' ') : null };
    }
}

interface RunContext {
    job: ImportJobRecord;
    mapping: ResolvedMapping;
    sourceId: number;
    /** The list's public id, for timeline data. */
    listId: string;
    listNumericId: bigint;
}

const CONFLICT_MESSAGE =
    'The email and the phone number belong to two different leads. Merge them first, then import this row again.';

const REPORT_STATUS: Record<ImportRowStatusName | 'PENDING', string> = {
    CREATED: 'Imported',
    MATCHED: 'Duplicate',
    SKIPPED: 'Skipped',
    ERROR: 'Error',
    PENDING: 'Not processed',
};

