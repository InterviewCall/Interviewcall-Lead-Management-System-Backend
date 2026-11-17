import { z } from 'zod';
import { OPPORTUNITY_STAGES, PAYMENT_MODES } from './pipeline.types.js';

export const moveStageSchema = z.strictObject({
    stage: z.enum(OPPORTUNITY_STAGES, 'Choose a pipeline stage'),
});
export type MoveStageBody = z.infer<typeof moveStageSchema>;

export const markLostSchema = z.strictObject({
    reasonId: z.number('Choose a reason').int().positive('Choose a reason'),
    note: z
        .string()
        .trim()
        .max(255, 'The note is too long (255 characters at most)')
        .nullish()
        .transform((value) => (value ? value : null)),
});
export type MarkLostBody = z.infer<typeof markLostSchema>;

export const boardQuerySchema = z.object({
    temperature: z.enum(['HOT', 'WARM', 'COLD'], 'Unknown temperature').optional(),
    ownerId: z.union([z.uuid('Invalid owner'), z.literal('none')]).optional(),
    /** Cards to send for each stage; the counts always cover every opportunity. */
    perColumn: z.coerce.number().int().min(1).max(60).default(8),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

const rupees = (label: string) =>
    z.number(`Enter the ${label} in rupees`).int(`Enter the ${label} in whole rupees`).min(0, `The ${label} cannot be negative`).max(10_000_000, `The ${label} looks too large`);

/** Payment details for a won deal. The amount collected cannot be more than the fee. */
export const enrolmentSchema = z
    .strictObject(
        {
            program: z
                .string()
                .trim()
                .max(120, 'The programme name is too long')
                .nullish()
                .transform((v) => (v ? v : null)),
            feeAmount: rupees('fee').min(1, 'Enter the fee agreed'),
            amountCollected: rupees('amount collected'),
            paymentMode: z.enum(PAYMENT_MODES, 'Choose how they are paying'),
            note: z
                .string()
                .trim()
                .max(255, 'The note is too long (255 characters at most)')
                .nullish()
                .transform((v) => (v ? v : null)),
        },
        'Send a JSON body with the payment details',
    )
    .refine((b) => b.amountCollected <= b.feeAmount, { path: ['amountCollected'], message: 'More than the fee has been entered as collected' });
export type EnrolmentBody = z.infer<typeof enrolmentSchema>;

const reasonName = z.string('Give the reason a name').trim().min(2, 'Give the reason a name').max(80, 'Keep the name to 80 characters');

export const createLostReasonSchema = z.strictObject({ name: reasonName });
export type CreateLostReasonBody = z.infer<typeof createLostReasonSchema>;

export const updateLostReasonSchema = z
    .strictObject({
        name: reasonName.optional(),
        isActive: z.boolean('Choose on or off').optional(),
        sortOrder: z.number('Enter a position').int().min(0).max(999).optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'Change at least one thing' });
export type UpdateLostReasonBody = z.infer<typeof updateLostReasonSchema>;

export const lostReasonIdSchema = z.coerce.number('Invalid reason').int().positive('Invalid reason');
