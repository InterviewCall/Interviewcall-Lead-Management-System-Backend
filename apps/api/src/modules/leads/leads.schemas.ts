import { z } from 'zod';
import { LEAD_VIEWS } from './leads.types.js';

export const leadIdSchema = z.uuid('Invalid lead id');

const STAGES = [
    'CALL_1_PENDING',
    'CALL_1',
    'TEST',
    'CALL_2',
    'PSYCHOMETRIC_SESSION',
    'DECISION_OBJECTION',
    'PAYMENT_FINANCING',
    'CLOSED_WON',
] as const;

export const LIFECYCLES = [
    'MARKETING_LEAD',
    'ENGAGED_LEAD',
    'PROSPECT',
    'ENROLLED',
    'LEARNER_ONBOARDED',
    'NOT_INTERESTED',
    'EXHAUSTED_NOT_CONNECTED',
] as const;

export const contactStageSchema = z.strictObject({
    stage: z.enum(LIFECYCLES, 'Choose a contact stage'),
});

export type ContactStageBody = z.infer<typeof contactStageSchema>;

export const listLeadsQuerySchema = z.object({
    view: z.enum(LEAD_VIEWS, 'Unknown view').default('all'),
    search: z.string().trim().max(100, 'Search is too long').optional(),
    sourceId: z.coerce.number().int().positive().optional(),
    temperature: z.enum(['HOT', 'WARM', 'COLD'], 'Unknown temperature').optional(),
    stage: z.enum(STAGES, 'Unknown stage').optional(),
    lifecycle: z.enum(LIFECYCLES, 'Unknown contact stage').optional(),
    ownerId: z.union([z.uuid('Invalid owner'), z.literal('none')]).optional(),
    listId: z.uuid('Invalid list').optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
