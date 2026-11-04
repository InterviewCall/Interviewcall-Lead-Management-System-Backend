import { z } from 'zod';

const uuid = (message: string) => z.uuid(message);

export const handoverSchema = z.object(
    {
        listId: uuid('Choose a list'),
        toUserId: uuid('Choose who takes the leads'),
    },
    'Send a JSON body with listId and toUserId',
);
export type HandoverBody = z.infer<typeof handoverSchema>;

export const bulkAssignSchema = z.object(
    {
        leadIds: z
            .array(uuid('Invalid lead id'), 'Choose the leads to assign')
            .min(1, 'Choose at least one lead')
            .max(500, 'Assign at most 500 leads at a time'),
        toUserId: uuid('Choose who takes the leads'),
    },
    'Send a JSON body with leadIds and toUserId',
);
export type BulkAssignBody = z.infer<typeof bulkAssignSchema>;
