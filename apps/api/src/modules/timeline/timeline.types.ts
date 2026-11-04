/** The event types the timeline records. One list, so a typo cannot create a second spelling. */
export const TimelineEvent = {
    LeadCreated: 'LEAD_CREATED',
    TouchpointAdded: 'TOUCHPOINT_ADDED',
    Assigned: 'ASSIGNED',
    OpportunityOpened: 'OPPORTUNITY_OPENED',
    ContactStageChanged: 'CONTACT_STAGE_CHANGED',
    OpportunityStageChanged: 'OPPORTUNITY_STAGE_CHANGED',
    OpportunityWon: 'OPPORTUNITY_WON',
    OpportunityLost: 'OPPORTUNITY_LOST',
} as const;

export type TimelineEvent = (typeof TimelineEvent)[keyof typeof TimelineEvent];

export interface NewTimelineEvent {
    leadId: bigint;
    type: TimelineEvent;
    actorType: 'SYSTEM' | 'USER' | 'SOURCE';
    actorId: bigint | null;
    /** Ids and field names only, never personal values. */
    data?: Record<string, unknown>;
    occurredAt?: Date;
}
