import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import type { ImportAssignmentInput, SystemAssignmentInput } from './assignment.types.js';

export interface BatchHistoryRow {
    batchId: string;
    method: 'BULK' | 'EQUAL_DISTRIBUTION';
    count: number;
    at: Date;
    byUserId: bigint | null;
    toUserIds: bigint[];
}

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

    /** A merge: the duplicate's assignment history belongs to the kept lead. */
    async moveLog(fromLeadId: bigint, toLeadId: bigint): Promise<void> {
        await this.db.leadAssignment.updateMany({ where: { leadId: fromLeadId }, data: { leadId: toLeadId } });
    }

    async insertMany(lines: AssignmentLogLine[]): Promise<void> {
        for (let i = 0; i < lines.length; i += 500) {
            await this.db.leadAssignment.createMany({ data: lines.slice(i, i + 500) });
        }
    }

    private static readonly CURSOR_SCOPE = 'default';

    /** Who got the last lead of the last equal distribution, or null before the first one. */
    async cursorUserId(): Promise<bigint | null> {
        const row = await this.db.distributionCursor.findUnique({
            where: { scope: AssignmentRepository.CURSOR_SCOPE },
            select: { lastUserId: true },
        });
        return row?.lastUserId ?? null;
    }

    async setCursor(userId: bigint): Promise<void> {
        await this.db.distributionCursor.upsert({
            where: { scope: AssignmentRepository.CURSOR_SCOPE },
            create: { scope: AssignmentRepository.CURSOR_SCOPE, lastUserId: userId },
            update: { lastUserId: userId },
        });
    }

    /** Hot leads given to each of these people since `since`. */
    async hotReceived(userIds: bigint[], since: Date): Promise<Map<bigint, number>> {
        if (userIds.length === 0) return new Map();
        const rows = await this.db.leadAssignment.groupBy({
            by: ['toUserId'],
            where: { toUserId: { in: userIds }, temperature: 'HOT', createdAt: { gte: since } },
            _count: { _all: true },
        });
        return new Map(rows.flatMap((r) => (r.toUserId === null ? [] : [[r.toUserId, r._count._all] as const])));
    }

    /** The latest batches of manual and equal giving, newest first, with who did it and who got leads. */
    async recentBatches(take: number): Promise<BatchHistoryRow[]> {
        const groups = await this.db.leadAssignment.groupBy({
            by: ['batchId', 'method'],
            where: { method: { in: ['BULK', 'EQUAL_DISTRIBUTION'] }, batchId: { not: null } },
            _count: { _all: true },
            _max: { createdAt: true },
            orderBy: { _max: { createdAt: 'desc' } },
            take,
        });
        const ids = groups.flatMap((g) => (g.batchId ? [g.batchId] : []));
        if (ids.length === 0) return [];
        const people = await this.db.leadAssignment.findMany({
            where: { batchId: { in: ids } },
            distinct: ['batchId', 'toUserId', 'byUserId'],
            select: { batchId: true, toUserId: true, byUserId: true },
        });
        return groups.flatMap((g) => {
            if (!g.batchId || !g._max.createdAt) return [];
            const rows = people.filter((p) => p.batchId === g.batchId);
            return [
                {
                    batchId: g.batchId,
                    method: g.method as 'BULK' | 'EQUAL_DISTRIBUTION',
                    count: g._count._all,
                    at: g._max.createdAt,
                    byUserId: rows[0]?.byUserId ?? null,
                    toUserIds: [...new Set(rows.flatMap((r) => (r.toUserId === null ? [] : [r.toUserId])))],
                },
            ];
        });
    }

    /** How many different leads were given to this person in [from, to). */
    async countLeadsGivenTo(userId: bigint, from: Date, to: Date): Promise<number> {
        const rows = await this.db.leadAssignment.findMany({
            where: { toUserId: userId, createdAt: { gte: from, lt: to } },
            distinct: ['leadId'],
            select: { leadId: true },
        });
        return rows.length;
    }
}
