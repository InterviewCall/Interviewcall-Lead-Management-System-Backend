import type { Role } from '@app/rbac';

export type IdentityKind = 'EMAIL' | 'PHONE';

export interface IdentityKey {
    type: IdentityKind;
    /** A lower-case email, or the last ten digits of a phone number. */
    value: string;
}

/** A person who is already a lead, as the importer needs to see them. */
export interface LeadMatch {
    leadId: bigint;
    publicId: string;
    fullName: string;
}

/** The fields an imported row can bring. Null means the row had nothing for it. */
export type TouchpointKindName = 'IMPORT' | 'SIGNUP' | 'DETAILS' | 'FORM' | 'BOOKING' | 'MANUAL';

export interface ImportedLeadFields {
    fullName: string;
    email: string | null;
    phoneE164: string | null;
    phoneLast10: string | null;
    currentCompany: string | null;
    currentCtc: string | null;
    graduationYear: string | null;
    domain: string | null;
    userType: 'WORKING_PROFESSIONAL' | 'STUDENT' | 'UNKNOWN';
    custom: Record<string, string>;
}

export type DuplicateHandling = 'SKIP' | 'FILL_EMPTY';

export interface ImportLeadInput {
    fields: ImportedLeadFields;
    sourceId: number;
    ownerId: bigint | null;
    /** The list the lead joins; none for leads that arrive on their own (the VSL). */
    listId: bigint | null;
    /** Unique per import row; makes a retry safe. */
    ref: string;
    handling: DuplicateHandling;
    /** The score the lead starts with. */
    initialScore: number;
    /** Kept with the first touchpoint (job id, list, source details). */
    touchpointPayload: Record<string, unknown>;
    /** What kind of touchpoint this is. A CSV import by default; a live signup says SIGNUP. */
    kind?: TouchpointKindName;
    /** Why the starting score was given. IMPORT_INITIAL by default. */
    scoreReason?: string;
}

/**
 * What happened to one imported row.
 * - CREATED: a new lead (`resumed` when an earlier attempt had already created it).
 * - MATCHED: the person is already a lead; nothing new was created. `matchedOn` says whether the email,
 *   the phone or both found them. `filled` lists the fields filled in
 *   (`resumed` when an earlier attempt had already handled the row).
 * - CONFLICT: the email belongs to one lead and the phone to another, so it is left for a person to merge.
 */
export type ImportLeadOutcome =
    | { kind: 'CREATED'; leadId: bigint; resumed: boolean }
    | { kind: 'MATCHED'; match: LeadMatch; matchedOn: IdentityKind[]; filled: string[]; resumed: boolean }
    | { kind: 'CONFLICT'; first: LeadMatch; second: LeadMatch };

export interface LeadSourceView {
    id: number;
    name: string;
    group: string;
}

/** A source with the rule that decides which events belong to it (an admin can edit the rule). */
export interface LeadSourceRule extends LeadSourceView {
    matchRule: unknown;
}

export type VslDepthName = 'NONE' | 'DETAILS' | 'FORM' | 'BOOKED';
export type TemperatureName = 'HOT' | 'WARM' | 'COLD';

/** What the CRM keeps of how far a person got on the VSL. */
export interface VslState {
    leadId: bigint;
    lifecycleStage: string;
    ownerId: bigint | null;
    vslDepth: VslDepthName;
    formScore: number | null;
    temperature: TemperatureName | null;
}

export interface FormResponseInput {
    leadId: bigint;
    formSlug: string;
    submissionRef: string;
    score: number | null;
    temperature: TemperatureName | null;
    answers: Array<{ key: string; question: string; answer: string }>;
    submittedAt: Date;
}

export interface BookingInput {
    leadId: bigint;
    bookingRef: string;
    submissionRef: string;
    slotStartAt: Date;
    slotLabel: string;
}

export interface BookingRow {
    id: bigint;
    leadId: bigint;
    status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
    slotStartAt: Date;
    slotLabel: string;
}

/** A booking as the nightly check sees it, with who owns the lead. */
export interface BookingCheckRow {
    bookingRef: string;
    leadId: bigint;
    status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
    slotStartAt: Date;
    slotLabel: string;
    ownerId: bigint | null;
    lifecycleStage: string;
}

/** The VSL part of the lead page. */
export interface VslSummaryRow {
    forms: Array<{
        formSlug: string;
        score: number | null;
        temperature: TemperatureName | null;
        answers: unknown;
        submittedAt: Date;
    }>;
    bookings: Array<{
        slotStartAt: Date;
        slotLabel: string;
        status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
        completedAt: Date | null;
    }>;
}

export interface CustomFieldView {
    key: string;
    label: string;
}

export interface LeadListRecord {
    id: bigint;
    publicId: string;
    name: string;
}

export const ALL_ROLES_FOR_NEW_FIELDS: readonly Role[] = [
    'BDA',
    'SALES_MANAGER',
    'CLOSER',
    'OPS',
    'ADMIN',
];

// ---- reading leads ----

export const LEAD_VIEWS = ['all', 'mine', 'unassigned', 'booked', 'hot', 'due'] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

/** Which leads a person may see. Decided from their role, never from the request. */
export type LeadScope =
    | { kind: 'ALL' }
    /** A BDA sees only their own leads. */
    | { kind: 'OWNED_BY'; staffPublicId: string }
    /** A closer sees leads that have an open opportunity. */
    | { kind: 'OPEN_OPPORTUNITY' };

export interface LeadSearch {
    scope: LeadScope;
    /** The signed-in person's public id, for the "mine" view. */
    me: string;
    view: LeadView;
    search?: string;
    sourceId?: number;
    temperature?: 'HOT' | 'WARM' | 'COLD';
    stage?: string;
    lifecycle?: string;
    /** A staff public id, or 'none' for leads without an owner. */
    ownerId?: string;
    listId?: string;
    /** Leads captured on or after this moment / before this moment. */
    capturedFrom?: Date;
    capturedTo?: Date;
    skip: number;
    take: number;
}

export interface LeadListRow {
    id: bigint;
    publicId: string;
    fullName: string;
    email: string | null;
    phoneE164: string | null;
    lifecycleStage: string;
    temperature: 'HOT' | 'WARM' | 'COLD' | null;
    leadScore: number;
    capturedAt: Date;
    /** The last call or note logged on the lead; null when none was. */
    lastActivityAt: Date | null;
    nextFollowupAt: Date | null;
    owner: { publicId: string; name: string } | null;
    firstSource: { id: number; name: string };
    opportunities: Array<{ stage: string; status: string; scheduledCallAt: Date | null }>;
}

export interface LeadDetailRow extends LeadListRow {
    currentCompany: string | null;
    currentCtc: string | null;
    graduationYear: string | null;
    domain: string | null;
    userType: string;
    doNotContact: boolean;
    custom: unknown;
    vslDepth: VslDepthName;
    formScore: number | null;
    listMembers: Array<{ list: { publicId: string; name: string } }>;
    scoreEntries: Array<{ id: bigint; points: number; reason: string; createdAt: Date }>;
    events: Array<{
        id: bigint;
        type: string;
        actorType: 'SYSTEM' | 'USER' | 'SOURCE';
        actorId: bigint | null;
        data: unknown;
        occurredAt: Date;
    }>;
    detailOpportunity: {
        stage: string;
        status: string;
        openedAt: Date;
        stageChangedAt: Date;
        closedAt: Date | null;
        testOn: Date | null;
        psychometricOn: Date | null;
        wonOn: Date | null;
        lostNote: string | null;
        lostReason: { name: string } | null;
        enrolment: {
            program: string | null;
            feeAmount: number;
            amountCollected: number;
            paymentMode: string;
            note: string | null;
            updatedAt: Date;
        } | null;
    } | null;
}

export interface LeadListOption {
    id: string;
    name: string;
    members: number;
}

/** A lead as the assignment code needs it: who has it now, and what to copy into the log. */
export interface AssignableLead {
    id: bigint;
    publicId: string;
    ownerId: bigint | null;
    firstSourceId: number;
    vslDepth: 'NONE' | 'DETAILS' | 'FORM' | 'BOOKED';
    temperature: 'HOT' | 'WARM' | 'COLD' | null;
}

/** One automatic list (for example a day's WorkR signups) and how much of it is still waiting. */
export interface BatchRow {
    publicId: string;
    name: string;
    createdAt: Date;
    /** The staff user the leads were created for (the intake owner). */
    ownerId: bigint;
    total: number;
    /** Members still owned by that person. */
    waiting: number;
}

// ---- the pipeline board ----

export interface BoardFilters {
    temperature?: 'HOT' | 'WARM' | 'COLD';
    /** A staff public id, or 'none' for leads without an owner. */
    ownerId?: string;
}

/** One opportunity as a card on the board. */
export interface BoardCardRow {
    stage: string;
    stageChangedAt: Date;
    scheduledCallAt: Date | null;
    testOn: Date | null;
    psychometricOn: Date | null;
    wonOn: Date | null;
    lead: {
        publicId: string;
        fullName: string;
        currentCompany: string | null;
        domain: string | null;
        temperature: 'HOT' | 'WARM' | 'COLD' | null;
        nextFollowupAt: Date | null;
        owner: { publicId: string; name: string } | null;
        firstSource: { name: string };
    };
}

export interface BoardRows {
    /** Open opportunities per stage, and the ones won this month under CLOSED_WON. */
    counts: Record<string, number>;
    lostThisMonth: number;
    cards: Record<string, BoardCardRow[]>;
}

/** What the Assignment page may narrow the waiting leads by. */
export interface QueueFilters {
    tab: 'all' | 'booked' | 'hot';
    sourceId?: number;
    depth?: VslDepthName;
    temperature?: TemperatureName;
    /** Hours since the lead first came in: under 6, 6 to 24, over 24. */
    wait?: 'lt6' | '6to24' | 'gt24';
    limit: number;
}

export interface QueueItemRow {
    publicId: string;
    fullName: string;
    email: string | null;
    currentCompany: string | null;
    domain: string | null;
    vslDepth: VslDepthName;
    temperature: TemperatureName | null;
    capturedAt: Date;
    firstSource: { id: number; name: string };
    /** The booked call time, when the lead has one. */
    scheduledCallAt: Date | null;
}

export interface QueueRows {
    items: QueueItemRow[];
    /** Every lead that matches the filters (up to the cap), in queue order, for "select all". */
    matchingIds: string[];
    total: number;
    counts: { all: number; booked: number; hot: number };
    sources: Array<{ id: number; name: string }>;
}

export interface OwnerLoadRow {
    ownerId: bigint;
    open: number;
}

/** Fields a person may edit on a lead, and the names the timeline and audit use for them. */
export const EDITABLE_FIELDS = ['fullName', 'email', 'phone', 'currentCompany', 'currentCtc', 'graduationYear', 'domain'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface LeadDetailsPatch {
    fullName?: string;
    email?: string | null;
    phone?: { phoneE164: string; phoneLast10: string } | null;
    currentCompany?: string | null;
    currentCtc?: string | null;
    graduationYear?: string | null;
    domain?: string | null;
}

/**
 * What an edit did: the fields that really changed, or the other lead that already holds the email or
 * phone (a person is only ever one lead).
 */
export type LeadDetailsUpdate =
    | { kind: 'UPDATED'; changed: EditableField[] }
    | { kind: 'TAKEN'; field: 'email' | 'phone'; leadId: bigint }
    | { kind: 'NOT_FOUND' };

/** A lead source as the admin's Sources screen shows it. */
export interface SourceAdminView {
    id: number;
    name: string;
    group: string;
    isActive: boolean;
    /** Used by the CRM itself (WorkR signups, VSL routing, CSV imports, the Organic fallback): it cannot be renamed or switched off here. */
    system: boolean;
    /** Leads that first came from it. */
    leads: number;
    createdAt: string;
}

/** The answer to a change made to many leads at once: how many changed, and why the others were left alone. */
export interface BulkResult {
    /** Leads that changed. */
    done: number;
    /** Leads that were already as asked. */
    unchanged: number;
    /** Leads left alone, grouped by the reason. */
    skipped: Array<{ reason: string; count: number }>;
}
