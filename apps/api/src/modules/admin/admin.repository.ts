import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type { AuditEntry } from './audit.types.js';

/**
 * The only class allowed to read or write this module's tables:
 * audit_log, app_settings.
 * Other modules call AdminService instead of touching these models.
 */
@Injectable()
export class AdminRepository {
    constructor(private readonly db: ModelService) {}

    async ping(): Promise<void> {
        await this.db.$queryRaw`SELECT 1`;
    }

    /** Appends one row. The audit log is never updated or deleted from here. */
    async insertAudit(entry: AuditEntry): Promise<void> {
        await this.db.auditLog.create({
            data: {
                actorId: entry.actorId,
                action: entry.action,
                entityType: entry.entityType,
                entityId: entry.entityId ?? null,
                // Left out when there is none, so the column stays SQL NULL.
                ...(entry.detail
                    ? { detail: entry.detail as Prisma.InputJsonObject }
                    : {}),
                ip: entry.ip?.slice(0, 45) ?? null,
            },
        });
    }
}
