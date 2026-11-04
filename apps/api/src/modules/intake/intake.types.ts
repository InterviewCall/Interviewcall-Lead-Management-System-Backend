import type { SourceSystemName } from '@modules/iam';

export type InboxStatusName = 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD';
/** CREATED: a new lead. MATCHED: a WorkR signup that was already a lead. UPDATED: a VSL step added to a lead. IGNORED: not for the CRM. */
export type IntakeOutcome = 'CREATED' | 'MATCHED' | 'UPDATED' | 'IGNORED';

/** An event as the worker handles it. */
export interface InboxRow {
    id: bigint;
    eventId: string;
    source: SourceSystemName;
    type: string;
    occurredAt: Date;
    payload: unknown;
    attempts: number;
}

/** A row of the Intake monitor's list, before lead names are filled in. */
export interface InboxListRow {
    id: bigint;
    source: SourceSystemName;
    type: string;
    status: InboxStatusName;
    attempts: number;
    lastError: string | null;
    outcome: string | null;
    leadId: bigint | null;
    receivedAt: Date;
}

export interface EventView {
    id: string;
    at: string;
    source: string;
    event: string;
    status: 'Received' | 'Processed' | 'Failed' | 'Dead';
    tries: number;
    /** The lead's name when processed, otherwise what went wrong or what is waiting. */
    detail: string;
    /** The lead's public id, to open it. */
    leadId: string | null;
}

export interface SourceHealth {
    id: SourceSystemName;
    name: string;
    events: string;
    status: 'Healthy' | 'Quiet' | 'Never';
    lastEvent: string | null;
    today: number;
    /** Events per hour for the last 12 hours, oldest first. */
    spark: number[];
}

export interface IntakeSummary {
    received: number;
    processed: number;
    failed: number;
    dead: number;
    created: number;
    sources: SourceHealth[];
}

/** Thrown for an event that will never work as sent. It is marked DEAD without further tries. */
export class PermanentIntakeError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}
