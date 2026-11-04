/** The pipeline's stages, first to last. A new opportunity starts at the first one. */
export const OPPORTUNITY_STAGES = [
    'CALL_1_PENDING',
    'CALL_1',
    'TEST',
    'CALL_2',
    'PSYCHOMETRIC_SESSION',
    'DECISION_OBJECTION',
    'PAYMENT_FINANCING',
    'CLOSED_WON',
] as const;

export type OpportunityStageName = (typeof OPPORTUNITY_STAGES)[number];

/** Where an opportunity starts. */
export const FIRST_STAGE: OpportunityStageName = OPPORTUNITY_STAGES[0];

export interface OpenOpportunityInput {
    leadId: bigint;
    ownerId: bigint | null;
    stage?: OpportunityStageName;
    /** The staff user who caused it; null when the system did. */
    actorId: bigint | null;
}

export interface OpenedOpportunity {
    opportunityId: bigint;
    publicId: string;
    /** False when the lead already had an open opportunity, which is left as it is. */
    created: boolean;
}

export interface OpenOpportunityRef {
    id: bigint;
    publicId: string;
    stage: OpportunityStageName;
}

export interface LostReasonView {
    id: number;
    name: string;
}
