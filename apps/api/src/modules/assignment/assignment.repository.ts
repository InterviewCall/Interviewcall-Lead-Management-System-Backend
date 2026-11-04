import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import type { ImportAssignmentInput, SystemAssignmentInput } from './assignment.types.js';

export interface AssignmentLogLine {
    leadId: bigint;
    fromUserId: bigint | null;
    toUserId: bigint;
    byUserId: bigint | null;
    method: 'MANUAL' | 'BULK' | 'EQUAL_DISTRIBUTION' | 'IMPORT' | 'SYSTEM';
    reasonCode: string | null;
    batchId: string;
    sourceId: number;
    vslDepth: 'NONE' | 'DETAILS' | 'FORM' | 'BOOKED';
    temperature: 'HOT' | 'WARM' | 'COLD' | null;
}

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

    async insertSystemEntry(input: SystemAssignmentInput): Promise<void> {
        await this.db.leadAssignment.create({
            data: {
                leadId: input.leadId,
                fromUserId: null,
                toUserId: input.toUserId,
                byUserId: null,
                method: 'SYSTEM',
                batchId: input.batchId.slice(0, 36),
                sourceId: input.sourceId,
                vslDepth: 'NONE',
                temperature: null,
            },
        });
    }

    async insertMany(lines: AssignmentLogLine[]): Promise<void> {
        for (let i = 0; i < lines.length; i += 500) {
            await this.db.leadAssignment.createMany({ data: lines.slice(i, i + 500) });
        }
    }
}
