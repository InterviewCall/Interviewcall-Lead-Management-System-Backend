import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type { AuditEntry, AuditFilter } from './audit.types.js';

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

    /** The id behind a signed-in person's public id, to record who changed a setting. Read-only. */
    async staffIdByPublicId(publicId: string): Promise<bigint | null> {
        return (await this.db.staffUser.findUnique({ where: { publicId }, select: { id: true } }))?.id ?? null;
    }

    async readSettings(keys: string[]): Promise<Map<string, unknown>> {
        const rows = await this.db.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
        return new Map(rows.map((r) => [r.key, r.value]));
    }

    async writeSetting(key: string, value: number, updatedById: bigint | null): Promise<void> {
        const json = { v: value };
        await this.db.appSetting.upsert({
            where: { key },
            create: { key, value: json, updatedById },
            update: { value: json, updatedById },
        });
    }

    private auditWhere(q: AuditFilter): Prisma.AuditLogWhereInput {
        return {
            ...(q.action ? (q.action.endsWith('.') ? { action: { startsWith: q.action } } : { action: q.action }) : {}),
            ...(q.actorPublicId ? { actor: { publicId: q.actorPublicId } } : {}),
            ...(q.entityType ? { entityType: q.entityType } : {}),
            ...(q.entityId ? { entityId: q.entityId } : {}),
            ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
        };
    }

    async listAudit(q: AuditFilter, skip: number, take: number) {
        const where = this.auditWhere(q);
        const [total, rows] = await Promise.all([
            this.db.auditLog.count({ where }),
            this.db.auditLog.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip,
                take,
                select: {
                    id: true, action: true, entityType: true, entityId: true, detail: true, ip: true, createdAt: true,
                    actor: { select: { publicId: true, name: true } },
                },
            }),
        ]);
        return { total, rows };
    }

    async auditActions(): Promise<string[]> {
        const rows = await this.db.auditLog.groupBy({ by: ['action'], orderBy: { action: 'asc' } });
        return rows.map((r) => r.action);
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
