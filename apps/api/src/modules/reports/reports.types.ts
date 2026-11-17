export const REPORT_RANGES = [7, 30, 90] as const;
export type ReportDays = (typeof REPORT_RANGES)[number];

/** The pipeline's stages, first to last (the funnel's rows). */
export const FUNNEL_STAGES = [
    'CALL_1_PENDING',
    'CALL_1',
    'TEST',
    'CALL_2',
    'PSYCHOMETRIC_SESSION',
    'DECISION_OBJECTION',
    'PAYMENT_FINANCING',
    'CLOSED_WON',
] as const;

export const SOURCE_GROUPS = ['WORKR', 'VSL', 'META', 'ORGANIC', 'IMPORT', 'REFERRAL', 'OTHER'] as const;
export type SourceGroupName = (typeof SOURCE_GROUPS)[number];

/** What narrows every figure: a BDA's own leads, and one source group. */
export interface ReportFilter {
    ownerId: bigint | null;
    group: SourceGroupName | null;
}

export interface LeadCountRow {
    ownerId: bigint | null;
    total: number;
    /** Leads whose first hour is over (or that were already contacted), so "contacted in 1 hour" can be judged. */
    eligible: number;
    contacted: number;
}

export interface OwnerCountRow {
    ownerId: bigint | null;
    count: number;
}

export interface CallCountRow {
    userId: bigint;
    total: number;
    connected: number;
}

export interface StaffRow {
    id: bigint;
    publicId: string;
    name: string;
}

/** One lead's wait for its first touch: seconds, or null when nobody has touched it yet. */
export interface FirstTouchRow {
    group: SourceGroupName;
    /** Seconds between arriving and the first logged touch. Null when there is none. */
    seconds: number | null;
    /** Seconds since it arrived (to judge a lead nobody has touched). */
    ageSeconds: number;
}

export interface StageAgeRow {
    stage: string;
    open: number;
    avgDays: number;
    maxDays: number;
    stale: number;
}

export interface StuckRow {
    leadId: string;
    name: string;
    stage: string;
    days: number;
    ownerName: string | null;
}

export interface AssignedRow {
    userId: bigint;
    assigned: number;
    hot: number;
    deepVsl: number;
}
