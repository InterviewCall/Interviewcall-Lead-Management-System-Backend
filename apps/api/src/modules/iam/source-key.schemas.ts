import { z } from 'zod';
import { SOURCE_SYSTEMS } from './iam.types.js';

export const createSourceKeySchema = z.object(
    {
        name: z
            .string('Enter a name')
            .trim()
            .min(3, 'Enter a name of at least 3 characters')
            .max(60, 'Name is too long'),
        system: z.enum(SOURCE_SYSTEMS, 'Choose which service will use this key'),
    },
    'Send a JSON body with a name and a system',
);

export type CreateSourceKeyBody = z.infer<typeof createSourceKeySchema>;

export const sourceKeyIdSchema = z.coerce
    .number('Invalid key id')
    .int('Invalid key id')
    .positive('Invalid key id');
