import { z } from 'zod';
import { FIELD_KEYS } from './import-fields.js';

export const importIdSchema = z.uuid('Invalid import id');

const optionalText = (max: number, tooLong: string) =>
    z
        .string()
        .trim()
        .max(max, tooLong)
        .nullish()
        .transform((value) => (value ? value : null));

export const configureImportSchema = z.strictObject(
    {
        mapping: z
            .array(
                z.strictObject({
                    index: z.number('Column must be a number').int().min(0).max(1000),
                    target: z.enum([...FIELD_KEYS, 'custom', 'skip'], 'Choose a field for each column'),
                    label: z.string().trim().max(60, 'Field name is too long').optional(),
                }),
                'Send the column mapping',
            )
            .max(100, 'Too many columns'),
        listName: z
            .string('Give the list a name')
            .trim()
            .min(2, 'The list name needs at least 2 characters')
            .max(120, 'The list name is too long (120 characters at most)'),
        listDescription: optionalText(500, 'The description is too long (500 characters at most)'),
        ownerId: z.uuid('Choose an owner').nullish().transform((v) => v ?? null),
        sourceId: z.number('Choose a lead source').int().positive('Choose a lead source'),
        duplicateMode: z.enum(['SKIP', 'FILL_EMPTY'], 'Choose what to do with duplicates').default('SKIP'),
        note: optionalText(500, 'The note is too long (500 characters at most)'),
    },
    'Send a JSON body with the mapping, list name, source and owner',
);

export type ConfigureImportBody = z.infer<typeof configureImportSchema>;

export const listImportsQuerySchema = z.object({
    status: z
        .enum(['UPLOADED', 'MAPPED', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'], 'Unknown status')
        .optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;

export const listRowsQuerySchema = z.object({
    status: z.enum(['CREATED', 'MATCHED', 'SKIPPED', 'ERROR'], 'Unknown status').optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListRowsQuery = z.infer<typeof listRowsQuerySchema>;
