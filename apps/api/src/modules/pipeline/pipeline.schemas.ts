import { z } from 'zod';
import { OPPORTUNITY_STAGES } from './pipeline.types.js';

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
