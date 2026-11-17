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

export type QueueDepth = 'NONE' | 'DETAILS' | 'FORM' | 'BOOKED';

export interface QueueItemView {
    id: string;
    name: string;
    email: string | null;
    company: string | null;
    domain: string | null;
    depth: QueueDepth;
    temperature: 'HOT' | 'WARM' | 'COLD' | null;
    source: string;
    /** Whole hours since the person first came in. */
    waitingHours: number;
    /** When the booked call is, if there is one. */
    bookedAt: string | null;
}

export interface QueueView {
    items: QueueItemView[];
    matchingIds: string[];
    total: number;
    counts: { all: number; booked: number; hot: number };
    sources: Array<{ id: number; name: string }>;
}

export interface LoadView {
    id: string;
    name: string;
    /** BDAs are in the round robin by default; sales managers can be added to it. */
    role: 'SALES_MANAGER' | 'BDA';
    /** Leads they hold that are still in play. */
    open: number;
    /** Hot leads given to them in the last 7 days. */
    hotReceived: number;
    /** Last day away (YYYY-MM-DD), when on leave today. */
    leaveUntil: string | null;
}

export interface LoadsView {
    bdas: LoadView[];
    /** The BDA who got the last lead of the last equal distribution: the next one continues after them. */
    cursorUserId: string | null;
}

export interface DistributeResult {
    assigned: number;
    skipped: number;
    perPerson: Array<{ id: string; name: string; count: number }>;
}

export interface HistoryView {
    id: string;
    at: string;
    by: string;
    count: number;
    method: 'BULK' | 'EQUAL_DISTRIBUTION';
    people: string[];
}
