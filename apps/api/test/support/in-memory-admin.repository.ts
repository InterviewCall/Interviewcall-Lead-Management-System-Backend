import type { AuditEntry } from '../../src/modules/admin/audit.types.js';

/** Stands in for AdminRepository in e2e tests and keeps the audit lines for assertions. */
export class InMemoryAdminRepository {
    readonly audits: AuditEntry[] = [];

    async ping(): Promise<void> {}

    async insertAudit(entry: AuditEntry): Promise<void> {
        this.audits.push(entry);
    }

    /** The audit lines for one action, oldest first. */
    byAction(action: AuditEntry['action']): AuditEntry[] {
        return this.audits.filter((entry) => entry.action === action);
    }
}
