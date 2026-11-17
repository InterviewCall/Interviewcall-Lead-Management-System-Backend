/**
 * The lead score: how it grows on its own as a lead engages and moves through the sale.
 *
 * Every rule is worked out from the timeline: when an event is written, the matching rule adds its points to the
 * lead's score ledger. A rule that can happen once per lead (reaching a stage, booking a call) gives its points
 * the first time only, so a lead moved back and forward again is not counted twice. A connected call counts each
 * time. Not interested and exhausted take points away. The VSL form's own score (0 to 100) is added separately
 * (see LeadsRepository.applyFormScore).
 *
 * The points that arrive with the VSL (details, a booked slot, the form score) are HELD: they are not counted until the
 * team has tried the lead once (a call, WhatsApp or email, answered or not; a note does not count). The first attempt
 * releases them, and the score grows from there. See ScoringService.
 */

/** What the rules read from a timeline event. */
export interface ScoreEvent {
    type: string;
    data: Record<string, unknown> | null;
}

/** Points to add, why, and what they are for (one award per reason and ref). */
export interface ScoreAward {
    points: number;
    reason: string;
    ref: string;
}

/** Points for reaching each pipeline stage, the first time. */
export const STAGE_POINTS: Readonly<Record<string, number>> = {
    CALL_1: 10,
    TEST: 10,
    CALL_2: 15,
    PSYCHOMETRIC_SESSION: 15,
    DECISION_OBJECTION: 20,
    PAYMENT_FINANCING: 25,
};

/** Points for a contact stage, the first time the lead reaches it. Negative ones take points away. */
export const CONTACT_STAGE_POINTS: Readonly<Record<string, number>> = {
    ENGAGED_LEAD: 5,
    PROSPECT: 15,
    EXHAUSTED_NOT_CONNECTED: -10,
    NOT_INTERESTED: -25,
};

export const POINTS = {
    vslDetails: 5,
    slotBooked: 20,
    callAttended: 10,
    callConnected: 10,
    won: 40,
} as const;

/** The reasons written to the ledger. Kept short: the column holds 60 characters. */
export const ScoreReason = {
    VslDetails: 'VSL_DETAILS',
    SlotBooked: 'VSL_SLOT_BOOKED',
    CallAttended: 'VSL_CALL_ATTENDED',
    CallConnected: 'CALL_CONNECTED',
    ContactStage: (stage: string) => `CONTACT_STAGE_${stage}`,
    PipelineStage: (stage: string) => `PIPELINE_${stage}`,
    Won: 'CLOSED_WON',
} as const;

/** The rules as people read them, for the lead page. */
export const SCORE_RULES: ReadonlyArray<{ label: string; points: number | null; once: boolean }> = [
    { label: 'VSL points count once the team has tried the lead (a call, WhatsApp or email, answered or not)', points: null, once: false },
    { label: 'Filled the VSL qualification form', points: null, once: false },
    { label: 'Gave their details on the VSL page', points: POINTS.vslDetails, once: true },
    { label: 'Booked a counselling call', points: POINTS.slotBooked, once: true },
    { label: 'Attended a booked call', points: POINTS.callAttended, once: false },
    { label: 'Connected call logged', points: POINTS.callConnected, once: false },
    { label: 'Became Engaged Lead', points: CONTACT_STAGE_POINTS.ENGAGED_LEAD!, once: true },
    { label: 'Became Prospect', points: CONTACT_STAGE_POINTS.PROSPECT!, once: true },
    { label: 'Reached Call 1', points: STAGE_POINTS.CALL_1!, once: true },
    { label: 'Reached Test', points: STAGE_POINTS.TEST!, once: true },
    { label: 'Reached Call 2', points: STAGE_POINTS.CALL_2!, once: true },
    { label: 'Reached Psychometric session', points: STAGE_POINTS.PSYCHOMETRIC_SESSION!, once: true },
    { label: 'Reached Decision / Objection', points: STAGE_POINTS.DECISION_OBJECTION!, once: true },
    { label: 'Reached Payment / Financing', points: STAGE_POINTS.PAYMENT_FINANCING!, once: true },
    { label: 'Closed as won', points: POINTS.won, once: true },
    { label: 'Marked Exhausted, not connected', points: CONTACT_STAGE_POINTS.EXHAUSTED_NOT_CONNECTED!, once: true },
    { label: 'Marked Not interested', points: CONTACT_STAGE_POINTS.NOT_INTERESTED!, once: true },
];

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The points a timeline event earns. `connected` is whether a logged call connected, for activity events (older
 * events do not carry it, so the caller looks it up).
 */
export function awardsFor(event: ScoreEvent, connected: boolean | null = null): ScoreAward[] {
    const data = event.data ?? {};
    switch (event.type) {
        case 'LEAD_CREATED':
        case 'TOUCHPOINT_ADDED':
            return data.via === 'VSL' ? [{ points: POINTS.vslDetails, reason: ScoreReason.VslDetails, ref: 'once' }] : [];
        case 'SLOT_BOOKED':
            return [{ points: POINTS.slotBooked, reason: ScoreReason.SlotBooked, ref: 'once' }];
        case 'BOOKING_COMPLETED': {
            const booking = text(data.booking);
            return booking ? [{ points: POINTS.callAttended, reason: ScoreReason.CallAttended, ref: `booking:${booking}` }] : [];
        }
        case 'ACTIVITY_LOGGED': {
            const activity = text(data.activity);
            return data.kind === 'CALL' && connected === true && activity
                ? [{ points: POINTS.callConnected, reason: ScoreReason.CallConnected, ref: `activity:${activity}` }]
                : [];
        }
        case 'CONTACT_STAGE_CHANGED': {
            const to = text(data.to);
            const points = to ? CONTACT_STAGE_POINTS[to] : undefined;
            return to && points ? [{ points, reason: ScoreReason.ContactStage(to), ref: 'once' }] : [];
        }
        case 'OPPORTUNITY_STAGE_CHANGED': {
            const to = text(data.to);
            const points = to ? STAGE_POINTS[to] : undefined;
            return to && points ? [{ points, reason: ScoreReason.PipelineStage(to), ref: 'once' }] : [];
        }
        case 'OPPORTUNITY_WON':
            return [{ points: POINTS.won, reason: ScoreReason.Won, ref: 'once' }];
        default:
            return [];
    }
}
