import { Injectable, Logger } from '@nestjs/common';
import { AdminRepository } from './admin.repository.js';
import type { AuditEntry } from './audit.types.js';

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
}
