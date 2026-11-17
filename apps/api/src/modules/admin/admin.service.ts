import { Injectable, Logger } from '@nestjs/common';
import { AdminRepository } from './admin.repository.js';
import type { AuthContext } from '@app/rbac';
import type { AuditQuery } from './admin.schemas.js';
import { type AuditEntry, AuditAction } from './audit.types.js';
import { resolveSetting, SETTING_KEYS, SETTINGS, type SettingKey, type SettingView, type UpdateSettingsBody } from './settings.js';

@Injectable()
export class AdminService {
    private readonly logger = new Logger(AdminService.name);

    constructor(private readonly repository: AdminRepository) {}

    /** Resolves when the database answers; rejects otherwise. */
    async checkDatabase(): Promise<void> {
        await this.repository.ping();
    }

    /**
     * Writes one audit line. It never throws: the action it describes has already happened, and
     * a full or unreachable audit table must not turn a successful sign-in or account change
     * into an error. A failed write is logged (action and entity only, never the detail).
     */
    async audit(entry: AuditEntry): Promise<void> {
        try {
            await this.repository.insertAudit(entry);
        } catch (error) {
            this.logger.error(
                `Could not write audit entry ${entry.action} for ${entry.entityType} ${entry.entityId ?? '-'}: ${
                    error instanceof Error ? error.name : 'unknown error'
                }`,
            );
        }
    }

    // ---- settings ----

    /** Every setting with its current value (the default when none was saved). */
    async getSettings(): Promise<SettingView[]> {
        const stored = await this.repository.readSettings(SETTING_KEYS);
        return SETTING_KEYS.map((key) => ({ key, ...SETTINGS[key], value: resolveSetting(key, stored.get(key)) }));
    }

    /** One setting's value, for the code that uses it. */
    async getSetting(key: SettingKey): Promise<number> {
        return resolveSetting(key, (await this.repository.readSettings([key])).get(key));
    }

    async updateSettings(auth: AuthContext, body: UpdateSettingsBody, ip?: string): Promise<SettingView[]> {
        const actor = await this.repository.staffIdByPublicId(auth.publicId);
        const before = await this.getSettings();
        const changed: Record<string, { from: number; to: number }> = {};
        for (const key of SETTING_KEYS) {
            const to = body[key];
            const from = before.find((s) => s.key === key)!.value;
            if (to === undefined || to === from) continue;
            await this.repository.writeSetting(key, to, actor);
            changed[key] = { from, to };
        }
        if (Object.keys(changed).length > 0) {
            await this.audit({ action: AuditAction.SettingsChanged, actorId: actor, entityType: 'settings', entityId: null, detail: changed, ip: ip ?? null });
        }
        return this.getSettings();
    }

    // ---- reading the audit log ----

    /** A page of the audit log, newest first. A day filter covers whole India-time days. */
    async listAudit(query: AuditQuery) {
        const istDay = (d: string, add = 0) => new Date(Date.parse(`${d}T00:00:00+05:30`) + add * 86_400_000);
        const { total, rows } = await this.repository.listAudit(
            {
                action: query.action || undefined,
                actorPublicId: query.actorId,
                entityType: query.entityType || undefined,
                entityId: query.entityId || undefined,
                from: query.from ? istDay(query.from) : undefined,
                to: query.to ? istDay(query.to, 1) : undefined,
            },
            (query.page - 1) * query.pageSize,
            query.pageSize,
        );
        return {
            total,
            page: query.page,
            pageSize: query.pageSize,
            entries: rows.map((r) => ({
                id: String(r.id),
                at: r.createdAt.toISOString(),
                action: r.action,
                entityType: r.entityType,
                entityId: r.entityId,
                detail: r.detail ?? null,
                ip: r.ip,
                actor: r.actor ? { id: r.actor.publicId, name: r.actor.name } : null,
            })),
        };
    }

    auditActions(): Promise<string[]> {
        return this.repository.auditActions();
    }
}
