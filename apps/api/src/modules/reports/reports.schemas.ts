import { z } from 'zod';
import { REPORT_RANGES, SOURCE_GROUPS } from './reports.types.js';

export const reportQuerySchema = z.object({
    days: z.coerce
        .number('Choose a date range')
        .refine((n) => (REPORT_RANGES as readonly number[]).includes(n), 'Choose 7, 30 or 90 days')
        .default(30),
    source: z.enum(SOURCE_GROUPS, 'Unknown source').optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
