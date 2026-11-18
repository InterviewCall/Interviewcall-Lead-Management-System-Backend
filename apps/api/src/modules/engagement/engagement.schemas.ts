import { z } from 'zod';
import { bulkLeadIdsSchema } from '@modules/leads';
import { OPPORTUNITY_STAGES } from '@modules/pipeline';
import { ACTIVITY_KINDS } from './engagement.types.js';

/**
 * What logging an outcome does. Every key is optional; a manager can change the outcomes without a deploy.
 * An unknown key is ignored, and a row that does not fit this shape does nothing rather than break a call.
 */
export const outcomeEffectSchema = z.object({
    lifecycle: z.enum(['ENGAGED_LEAD', 'PROSPECT', 'NOT_INTERESTED']).optional(),
    closeAs: z.literal('LOST').optional(),
    lostReason: z.string().min(1).max(60).optional(),
    connected: z.boolean().optional(),
    /** A real conversation took place (not just a pick-up and a "call me later"). Defaults to `connected`. Moves Call 1 Pending to Call 1. */
    conversation: z.boolean().optional(),
    countsAsAttempt: z.boolean().optional(),
});
export type OutcomeEffect = z.infer<typeof outcomeEffectSchema>;

export const parseEffect = (value: unknown): OutcomeEffect => {
    const parsed = outcomeEffectSchema.safeParse(value);
    return parsed.success ? parsed.data : {};
};

export const taskTitleSchema = z.string('Say what to do').trim().min(1, 'Say what to do').max(150, 'Keep it to 150 characters');
const dueAtSchema = z.iso.datetime({ offset: true, error: 'Choose when to follow up' }).transform((value) => new Date(value));

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? null);

export const logActivitySchema = z.strictObject({
    kind: z.enum(ACTIVITY_KINDS, 'Choose what to log'),
    outcomeId: nullable(z.number('Choose an outcome').int().positive('Choose an outcome')),
    notes: z
        .string()
        .trim()
        .max(2000, 'The notes are too long (2000 characters at most)')
        .nullish()
        .transform((value) => (value ? value : null)),
    stage: nullable(z.enum(OPPORTUNITY_STAGES, 'Choose a pipeline stage')),
    /** The day for the stage above, when it needs one: the test date, the psychometric session date, or the date it was won. */
    stageDate: nullable(z.iso.date('Choose a date')),
    temperature: nullable(z.enum(['HOT', 'WARM', 'COLD'], 'Choose a temperature')),
    nextStep: nullable(z.strictObject({ title: taskTitleSchema, dueAt: dueAtSchema })),
});
export type LogActivityBody = z.infer<typeof logActivitySchema>;

export const createTaskSchema = z.strictObject({ title: taskTitleSchema, dueAt: dueAtSchema });
export type CreateTaskBody = z.infer<typeof createTaskSchema>;

/** Change a follow-up: when it is due, what it says, and (managers and admins) who does it. */
export const updateTaskSchema = z
    .strictObject({
        title: taskTitleSchema.optional(),
        dueAt: dueAtSchema.optional(),
        assigneeId: z.uuid('Choose who should do it').optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Change at least one thing');
export type UpdateTaskBody = z.infer<typeof updateTaskSchema>;

/** The same follow-up for many leads at once. */
export const bulkTaskSchema = z.strictObject({ leadIds: bulkLeadIdsSchema, title: taskTitleSchema, dueAt: dueAtSchema });
export type BulkTaskBody = z.infer<typeof bulkTaskSchema>;

export const taskIdSchema = z.string().regex(/^[1-9]\d{0,17}$/, 'Invalid task id');

export const notificationIdSchema = z.string().regex(/^[1-9]\d{0,17}$/, 'Invalid notification id');

// ---- the outcome editor ----

const outcomeName = z.string('Give the outcome a name').trim().min(2, 'Give the outcome a name').max(80, 'Keep the name to 80 characters');

/** What the editor sets; it is turned into the stored `effect`. */
const outcomeFields = {
    requiresFollowup: z.boolean('Choose yes or no'),
    /** Whether the person picked up. null when it does not say (a note, say). */
    connected: z.boolean().nullable(),
    /** A real conversation happened (defaults to `connected`). */
    conversation: z.boolean().optional(),
    countsAsAttempt: z.boolean(),
    lifecycle: z.enum(['ENGAGED_LEAD', 'PROSPECT', 'NOT_INTERESTED'], 'Choose a contact stage').nullable(),
    /** Close the lead's opportunity as lost with this reason (a lost reason's name). */
    lostReason: z.string().trim().min(1).max(60).nullable(),
};

export const createOutcomeSchema = z.strictObject({ name: outcomeName, ...outcomeFields });
export type CreateOutcomeBody = z.infer<typeof createOutcomeSchema>;

export const updateOutcomeSchema = z
    .strictObject({
        name: outcomeName,
        isActive: z.boolean('Choose on or off'),
        sortOrder: z.number('Enter a position').int().min(0).max(999),
        ...outcomeFields,
    })
    .partial()
    .refine((b) => Object.keys(b).length > 0, { message: 'Change at least one thing' });
export type UpdateOutcomeBody = z.infer<typeof updateOutcomeSchema>;

export const outcomeIdSchema = z.coerce.number('Invalid outcome').int().positive('Invalid outcome');
