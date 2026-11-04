import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type { ColumnMapping } from './import-fields.js';
import type {
    ImportJobRecord,
    ImportRowRecord,
    ImportRowStatusName,
    ImportStatusName,
    JobConfiguration,
    NewImportJob,
    RowResult,
    StoredRowValue,
} from './imports.types.js';

const JOB_SELECT = {
    id: true,
    publicId: true,
    fileName: true,
    fileSize: true,
    headers: true,
    sourceId: true,
    ownerId: true,
    listId: true,
    listName: true,
    listDescription: true,
    note: true,
    duplicateMode: true,
    columnMapping: true,
    status: true,
    totalRows: true,
    processedCount: true,
    createdCount: true,
    matchedCount: true,
    skippedCount: true,
    errorCount: true,
    failureReason: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
    createdBy: { select: { id: true, publicId: true, name: true } },
    owner: { select: { id: true, publicId: true, name: true } },
    source: { select: { id: true, name: true } },
    list: { select: { publicId: true, name: true } },
} as const satisfies Prisma.ImportJobSelect;

type JobRow = Prisma.ImportJobGetPayload<{ select: typeof JOB_SELECT }>;

function toRecord(row: JobRow): ImportJobRecord {
    return {
        ...row,
        headers: row.headers as string[],
        columnMapping: row.columnMapping as ColumnMapping[] | null,
    };
}

const INSERT_BATCH = 1_000;

/**
 * The only class allowed to read or write this module's tables:
 * import_jobs, import_rows.
 * Other modules call ImportsService instead of touching these models.
 */
@Injectable()
export class ImportsRepository {
    constructor(private readonly db: ModelService) {}

    // ---- jobs ----

    /** Creates the job and stores every row, all or nothing. */
    async createWithRows(
        job: NewImportJob,
        rows: StoredRowValue[],
    ): Promise<ImportJobRecord> {
        const id = await this.db.$transaction(
            async (tx) => {
                const created = await tx.importJob.create({
                    data: {
                        createdById: job.createdById,
                        fileName: job.fileName,
                        fileSize: job.fileSize,
                        headers: job.headers,
                        totalRows: rows.length,
                    },
                    select: { id: true },
                });
                for (let start = 0; start < rows.length; start += INSERT_BATCH) {
                    await tx.importRow.createMany({
                        data: rows.slice(start, start + INSERT_BATCH).map((raw, i) => ({
                            jobId: created.id,
                            rowNo: start + i + 1,
                            raw: raw as unknown as Prisma.InputJsonValue,
                        })),
                    });
                }
                return created.id;
            },
            { timeout: 120_000, maxWait: 10_000 },
        );
        const record = await this.findById(id);
        if (!record) throw new Error('Import job vanished after it was created');
        return record;
    }

    async findByPublicId(publicId: string): Promise<ImportJobRecord | null> {
        const row = await this.db.importJob.findUnique({
            where: { publicId },
            select: JOB_SELECT,
        });
        return row ? toRecord(row) : null;
    }

    private async findById(id: bigint): Promise<ImportJobRecord | null> {
        const row = await this.db.importJob.findUnique({
            where: { id },
            select: JOB_SELECT,
        });
        return row ? toRecord(row) : null;
    }

    async list(filter: {
        status?: ImportStatusName;
        skip: number;
        take: number;
    }): Promise<{ jobs: ImportJobRecord[]; total: number }> {
        const where: Prisma.ImportJobWhereInput = filter.status
            ? { status: filter.status }
            : {};
        const [rows, total] = await Promise.all([
            this.db.importJob.findMany({
                where,
                select: JOB_SELECT,
                orderBy: { createdAt: 'desc' },
                skip: filter.skip,
                take: filter.take,
            }),
            this.db.importJob.count({ where }),
        ]);
        return { jobs: rows.map(toRecord), total };
    }

    /** Saves the settings, but only while the job has not started. Returns false if it had. */
    async saveConfiguration(
        id: bigint,
        config: JobConfiguration,
    ): Promise<boolean> {
        const result = await this.db.importJob.updateMany({
            where: { id, status: { in: ['UPLOADED', 'MAPPED'] } },
            data: {
                sourceId: config.sourceId,
                ownerId: config.ownerId,
                listName: config.listName,
                listDescription: config.listDescription,
                note: config.note,
                duplicateMode: config.duplicateMode,
                columnMapping: config.columnMapping as unknown as Prisma.InputJsonValue,
                status: 'MAPPED',
            },
        });
        return result.count === 1;
    }

    /**
     * Moves the job from one of the `from` statuses to `to`, as one atomic step, so two requests
     * cannot both win. Returns false if the job was not in a `from` status.
     */
    async transition(
        id: bigint,
        from: ImportStatusName[],
        to: ImportStatusName,
        extra: {
            listId?: bigint;
            failureReason?: string | null;
            startedAt?: Date;
            finishedAt?: Date | null;
        } = {},
    ): Promise<boolean> {
        const result = await this.db.importJob.updateMany({
            where: { id, status: { in: from } },
            data: { status: to, ...extra },
        });
        return result.count === 1;
    }

    /** Re-counts the rows by outcome and writes the totals onto the job. */
    async syncCounters(id: bigint): Promise<void> {
        const groups = await this.db.importRow.groupBy({
            by: ['status'],
            where: { jobId: id },
            _count: { _all: true },
        });
        const count = (status: ImportRowStatusName) =>
            groups.find((g) => g.status === status)?._count._all ?? 0;
        const created = count('CREATED');
        const matched = count('MATCHED');
        const skipped = count('SKIPPED');
        const errors = count('ERROR');
        await this.db.importJob.update({
            where: { id },
            data: {
                createdCount: created,
                matchedCount: matched,
                skippedCount: skipped,
                errorCount: errors,
                processedCount: created + matched + skipped + errors,
            },
        });
    }

    // ---- rows ----

    private toRow(row: {
        rowNo: number;
        raw: Prisma.JsonValue;
        status: ImportRowStatusName | null;
        leadId: bigint | null;
        message: string | null;
    }): ImportRowRecord {
        return { ...row, raw: row.raw as unknown as StoredRowValue };
    }

    /** Rows after `afterRowNo`, in order. With `pendingOnly`, only rows not processed yet. */
    async readRows(
        jobId: bigint,
        options: { afterRowNo: number; limit: number; pendingOnly?: boolean },
    ): Promise<ImportRowRecord[]> {
        const rows = await this.db.importRow.findMany({
            where: {
                jobId,
                rowNo: { gt: options.afterRowNo },
                ...(options.pendingOnly ? { status: null } : {}),
            },
            select: { rowNo: true, raw: true, status: true, leadId: true, message: true },
            orderBy: { rowNo: 'asc' },
            take: options.limit,
        });
        return rows.map((r) => this.toRow(r));
    }

    async rowsPage(
        jobId: bigint,
        filter: { status?: ImportRowStatusName; skip: number; take: number },
    ): Promise<{ rows: ImportRowRecord[]; total: number }> {
        const where: Prisma.ImportRowWhereInput = {
            jobId,
            ...(filter.status ? { status: filter.status } : {}),
        };
        const [rows, total] = await Promise.all([
            this.db.importRow.findMany({
                where,
                select: { rowNo: true, raw: true, status: true, leadId: true, message: true },
                orderBy: { rowNo: 'asc' },
                skip: filter.skip,
                take: filter.take,
            }),
            this.db.importRow.count({ where }),
        ]);
        return { rows: rows.map((r) => this.toRow(r)), total };
    }

    async markRow(jobId: bigint, rowNo: number, result: RowResult): Promise<void> {
        await this.db.importRow.update({
            where: { jobId_rowNo: { jobId, rowNo } },
            data: {
                status: result.status,
                leadId: result.leadId,
                message: result.message ? result.message.slice(0, 255) : null,
            },
        });
    }

    /** The row of this job that created the lead, if any (used to say "repeated in this file"). */
    async findRowNoThatCreated(jobId: bigint, leadId: bigint): Promise<number | null> {
        const row = await this.db.importRow.findFirst({
            where: { jobId, leadId, status: 'CREATED' },
            select: { rowNo: true },
        });
        return row?.rowNo ?? null;
    }
}
