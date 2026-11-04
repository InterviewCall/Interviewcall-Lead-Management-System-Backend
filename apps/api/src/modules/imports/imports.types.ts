import type { ColumnMapping } from './import-fields.js';

export type ImportStatusName =
    | 'UPLOADED'
    | 'MAPPED'
    | 'QUEUED'
    | 'RUNNING'
    | 'DONE'
    | 'FAILED'
    | 'CANCELLED';

export type ImportRowStatusName = 'CREATED' | 'MATCHED' | 'SKIPPED' | 'ERROR';

export type DuplicateModeName = 'SKIP' | 'FILL_EMPTY';

export interface StoredRowValue {
    line: number;
    cells: string[];
}

export interface ImportJobRecord {
    id: bigint;
    publicId: string;
    fileName: string;
    fileSize: number;
    headers: string[];
    sourceId: number | null;
    ownerId: bigint | null;
    listId: bigint | null;
    listName: string | null;
    listDescription: string | null;
    note: string | null;
    duplicateMode: DuplicateModeName;
    columnMapping: ColumnMapping[] | null;
    status: ImportStatusName;
    totalRows: number;
    processedCount: number;
    createdCount: number;
    matchedCount: number;
    skippedCount: number;
    errorCount: number;
    failureReason: string | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdBy: { id: bigint; publicId: string; name: string };
    owner: { id: bigint; publicId: string; name: string } | null;
    source: { id: number; name: string } | null;
    list: { publicId: string; name: string } | null;
}

export interface ImportRowRecord {
    rowNo: number;
    raw: StoredRowValue;
    status: ImportRowStatusName | null;
    leadId: bigint | null;
    message: string | null;
}

export interface NewImportJob {
    createdById: bigint;
    fileName: string;
    fileSize: number;
    headers: string[];
}

export interface JobConfiguration {
    sourceId: number;
    ownerId: bigint | null;
    listName: string;
    listDescription: string | null;
    note: string | null;
    duplicateMode: DuplicateModeName;
    columnMapping: ColumnMapping[];
}

export interface RowResult {
    status: ImportRowStatusName;
    leadId: bigint | null;
    message: string | null;
}

// ---- what the API returns ----

export interface ImportView {
    id: string;
    fileName: string;
    fileSize: number;
    status: ImportStatusName;
    headers: string[];
    mapping: ColumnMapping[] | null;
    listName: string | null;
    listDescription: string | null;
    listId: string | null;
    owner: { id: string; name: string } | null;
    source: { id: number; name: string } | null;
    duplicateMode: DuplicateModeName;
    note: string | null;
    counts: {
        total: number;
        processed: number;
        created: number;
        matched: number;
        skipped: number;
        errors: number;
    };
    failureReason: string | null;
    createdBy: { id: string; name: string };
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface DryRunIssue {
    rowNo: number;
    /** The line in the file, so the row can be found in Excel. */
    line: number;
    kind: 'ERROR' | 'SKIPPED' | 'MATCHED' | 'WARNING';
    message: string;
    /** For MATCHED rows that match a lead already in the CRM. */
    existingLead?: { id: string; name: string };
}

export interface DryRunResult {
    summary: {
        total: number;
        new: number;
        matched: number;
        skipped: number;
        errors: number;
        warnings: number;
    };
    issues: DryRunIssue[];
    /** True when there were more issues than the list holds. */
    truncated: boolean;
    /** Names of fields the import will create. */
    newFields: string[];
}

export interface ImportRowView {
    rowNo: number;
    line: number;
    status: ImportRowStatusName | 'PENDING';
    message: string | null;
    cells: string[];
}
