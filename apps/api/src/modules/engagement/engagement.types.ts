export const ACTIVITY_KINDS = ['CALL', 'WHATSAPP', 'EMAIL', 'NOTE'] as const;
export type ActivityKindName = (typeof ACTIVITY_KINDS)[number];

/** After this many unanswered attempts in a row, a lead who never connected is marked Exhausted. */
export const EXHAUSTED_AFTER_ATTEMPTS = 3;

/** An outcome as the log-a-call form offers it. */
export interface OutcomeView {
    id: number;
    name: string;
    /** True when the person answered, false when they did not, null when it does not say. */
    connected: boolean | null;
    /** True when the call was a real conversation, so the lead moves to Call 1. */
    conversation: boolean;
    /** Logging it asks for the next follow-up. */
    requiresFollowup: boolean;
    /** Logging it ends the opportunity or the sales follow-up, so no next step is asked for. */
    ends: boolean;
}

export interface OutcomeRow {
    id: number;
    name: string;
    effect: unknown;
    requiresFollowup: boolean;
}

/** An outcome as the settings editor sees it. */
export interface OutcomeAdminRow extends OutcomeRow {
    isActive: boolean;
    sortOrder: number;
    /** Activities logged with it. */
    used: number;
}

export interface NewActivity {
    leadId: bigint;
    opportunityId: bigint | null;
    userId: bigint;
    kind: ActivityKindName;
    outcomeId: number | null;
    connected: boolean | null;
    attemptNo: number | null;
    notes: string | null;
    nextFollowupAt: Date | null;
}

export type TaskTypeName = 'FOLLOW_UP' | 'SCHEDULED_CALL' | 'DUPLICATE_REVIEW';
export type TaskStatusName = 'OPEN' | 'DONE' | 'CANCELLED';

export interface TaskRow {
    id: bigint;
    leadId: bigint;
    assigneeId: bigint | null;
    type: TaskTypeName;
    status: TaskStatusName;
    title: string;
    dueAt: Date;
    completedAt: Date | null;
    lead: { publicId: string };
}

/** A task on someone's My day list. */
export interface DayTaskRow {
    id: bigint;
    type: 'FOLLOW_UP' | 'SCHEDULED_CALL' | 'DUPLICATE_REVIEW';
    title: string;
    dueAt: Date;
    assigneeId: bigint | null;
    lead: { publicId: string; fullName: string; priorityRank: number; attemptCount: number };
}

/** A booked call still to be made. */
export interface BookedCallRow {
    id: bigint;
    dueAt: Date;
    assigneeId: bigint | null;
    lead: { publicId: string; fullName: string; currentCompany: string | null; domain: string | null };
}

export type NotificationTypeName = 'NEW_ASSIGNMENT' | 'BOOKED_SLOT_UNASSIGNED' | 'SLOT_SOON' | 'FOLLOWUP_OVERDUE' | 'DUPLICATE_REVIEW' | 'LEAD_REENGAGED';

export interface NewNotification {
    userId: bigint;
    type: NotificationTypeName;
    leadId?: bigint | null;
    /** Set for an alert about one task: the same task alerts the same person only once. */
    taskId?: bigint | null;
    message: string;
}

export interface NotificationRow {
    id: bigint;
    type: NotificationTypeName;
    message: string;
    readAt: Date | null;
    createdAt: Date;
    lead: { publicId: string; fullName: string } | null;
}

/** A task about to need its owner's attention. */
export interface TaskAlertRow {
    id: bigint;
    leadId: bigint;
    dueAt: Date;
}
