import { z } from 'zod';

const day = z.iso.date('Use a date like 2026-11-17');

export const auditQuerySchema = z.object({
    /** An exact action ("lead.exported") or a family ending in a dot ("lead."). */
    action: z.string().trim().max(60).optional(),
    actorId: z.uuid('Invalid person').optional(),
    entityType: z.string().trim().max(40).optional(),
    entityId: z.string().trim().max(64).optional(),
    from: day.optional(),
    to: day.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(10).max(100).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
