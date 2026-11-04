export interface ImportAssignmentInput {
    leadId: bigint;
    toUserId: bigint;
    byUserId: bigint | null;
    sourceId: number;
    /** The import's public id: one batch per import, so the log can be filtered by it. */
    batchId: string;
}

/** A lead the system gave to someone on its own, e.g. a WorkR signup going to the intake owner. */
export interface SystemAssignmentInput {
    leadId: bigint;
    toUserId: bigint;
    sourceId: number;
    /** Groups the log lines of one source of assignments, e.g. `workr-day:2026-11-05`. */
    batchId: string;
}

export interface AssigneeView {
    id: string;
    name: string;
    role: string;
}

export interface BatchView {
    /** The list's public id. */
    id: string;
    name: string;
    /** When the first lead of this batch arrived. */
    createdAt: string;
    total: number;
    /** Leads in it still with the person they arrived for. */
    waiting: number;
    /** Who they are with now (the intake owner). */
    ownerName: string;
}

export interface MoveResult {
    moved: number;
    /** Leads that were not moved: already with that person, changed hands meanwhile, or not found. */
    skipped: number;
    to: { id: string; name: string };
}
