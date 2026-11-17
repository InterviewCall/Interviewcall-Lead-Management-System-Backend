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

export const queueQuerySchema = z.object({
    tab: z.enum(['all', 'booked', 'hot']).default('all'),
    sourceId: z.coerce.number().int().positive().optional(),
    depth: z.enum(['NONE', 'DETAILS', 'FORM', 'BOOKED']).optional(),
    temperature: z.enum(['HOT', 'WARM', 'COLD']).optional(),
    wait: z.enum(['lt6', '6to24', 'gt24']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(8),
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;

export const distributeSchema = z.object(
    {
        leadIds: z
            .array(uuid('Invalid lead id'), 'Choose the leads to distribute')
            .min(1, 'Choose at least one lead')
            .max(500, 'Distribute at most 500 leads at a time'),
        /** The people to share the leads between, in the order the round robin goes. */
        toUserIds: z
            .array(uuid('Invalid person'), 'Choose who takes the leads')
            .min(1, 'Choose at least one person')
            .max(50, 'Too many people'),
    },
    'Send a JSON body with leadIds and toUserIds',
);
export type DistributeBody = z.infer<typeof distributeSchema>;

export const leaveSchema = z.object(
    {
        userId: uuid('Choose a person'),
        /** The last day away, as YYYY-MM-DD. Null ends the leave. */
        until: z.iso.date('Send the last day as YYYY-MM-DD').nullable(),
    },
    'Send a JSON body with userId and until',
);
export type LeaveBody = z.infer<typeof leaveSchema>;

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

export const moveFromPersonSchema = z.object(
    {
        /** The person whose leads move, usually someone leaving the team. */
        fromUserId: uuid('Choose whose leads move'),
        /** The people to share them between, in round-robin order. */
        toUserIds: z
            .array(uuid('Invalid person'), 'Choose who takes the leads')
            .min(1, 'Choose at least one person')
            .max(50, 'Too many people'),
    },
    'Send a JSON body with fromUserId and toUserIds',
);
export type MoveFromPersonBody = z.infer<typeof moveFromPersonSchema>;

export const ownedQuerySchema = z.object({ userId: uuid('Choose a person') });
export type OwnedQuery = z.infer<typeof ownedQuerySchema>;
