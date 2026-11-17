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
    FormSubmitted: 'FORM_SUBMITTED',
    SlotBooked: 'SLOT_BOOKED',
    BookingCompleted: 'BOOKING_COMPLETED',
    BookingCancelled: 'BOOKING_CANCELLED',
    BookingRescheduled: 'BOOKING_RESCHEDULED',
    BookingReopened: 'BOOKING_REOPENED',
    ActivityLogged: 'ACTIVITY_LOGGED',
    TaskCreated: 'TASK_CREATED',
    TaskDone: 'TASK_DONE',
    TaskUpdated: 'TASK_UPDATED',
    TaskCancelled: 'TASK_CANCELLED',
    TemperatureChanged: 'TEMPERATURE_CHANGED',
    DetailsEdited: 'DETAILS_EDITED',
    LeadsMerged: 'LEADS_MERGED',
    Anonymised: 'LEAD_ANONYMISED',
    DoNotContactSet: 'DO_NOT_CONTACT_SET',
    DoNotContactCleared: 'DO_NOT_CONTACT_CLEARED',
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
