import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import type { ImportAssignmentInput } from './assignment.types.js';

/**
 * The only class allowed to read or write this module's tables:
 * lead_assignments, distribution_cursors.
 * Other modules call AssignmentService instead of touching these models.
 */
@Injectable()
export class AssignmentRepository {
    constructor(private readonly db: ModelService) {}

    async hasBatchEntry(leadId: bigint, batchId: string): Promise<boolean> {
        const found = await this.db.leadAssignment.findFirst({
            where: { leadId, batchId },
            select: { id: true },
        });
        return found !== null;
    }

    async insertImportEntry(input: ImportAssignmentInput): Promise<void> {
        await this.db.leadAssignment.create({
            data: {
                leadId: input.leadId,
                fromUserId: null,
                toUserId: input.toUserId,
                byUserId: input.byUserId,
                method: 'IMPORT',
                batchId: input.batchId,
                sourceId: input.sourceId,
                // A freshly imported lead has not been through the VSL and has no temperature yet.
                vslDepth: 'NONE',
                temperature: null,
            },
        });
    }
}
