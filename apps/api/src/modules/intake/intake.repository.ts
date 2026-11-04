import { Injectable } from '@nestjs/common';
import { isUniqueViolation, ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type { SourceSystemName } from '@modules/iam';
import { PAYLOAD_KEEP_DAYS } from './intake.constants.js';
import type { InboxListRow, InboxRow, InboxStatusName } from './intake.types.js';

/**
 * The only class allowed to read or write this module's tables:
 * inbox_events, reconciliation_cursors.
 * Other modules call IntakeService instead of touching these models.
 */
@Injectable()
export class IntakeRepository {
    constructor(private readonly db: ModelService) {}

    /** Stores the event once. A repeat of the same (source, eventId) returns the one already stored. */
    async insertEvent(data: {
        eventId: string;
        source: SourceSystemName;
        type: string;
        occurredAt: Date;
        payload: object;
        now: Date;
    }): Promise<{ id: bigint; duplicate: boolean }> {
        try {
            const row = await this.db.inboxEvent.create({
                data: {
                    eventId: data.eventId,
                    source: data.source,
                    type: data.type,
                    occurredAt: data.occurredAt,
                    payload: data.payload as Prisma.InputJsonValue,
                    nextAttemptAt: data.now,
                },
                select: { id: true },
            });
            return { id: row.id, duplicate: false };
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            const existing = await this.db.inboxEvent.findUniqueOrThrow({
                where: { source_eventId: { source: data.source, eventId: data.eventId } },
                select: { id: true },
            });
            return { id: existing.id, duplicate: true };
        }
    }

    /**
     * Takes an event to work on: only one worker can, because the update only matches an event that
     * is waiting, failed, or held by a worker whose lock has run out.
     */
    async claim(id: bigint, now: Date, lockMs: number): Promise<InboxRow | null> {
        const taken = await this.db.inboxEvent.updateMany({
            where: {
                id,
                OR: [
                    { status: { in: ['RECEIVED', 'FAILED'] } },
                    { status: 'PROCESSING', nextAttemptAt: { lte: now } },
                ],
            },
            data: {
                status: 'PROCESSING',
                attempts: { increment: 1 },
                nextAttemptAt: new Date(now.getTime() + lockMs),
            },
        });
        if (taken.count === 0) return null;
        const row = await this.db.inboxEvent.findUnique({
            where: { id },
            select: { id: true, eventId: true, source: true, type: true, occurredAt: true, payload: true, attempts: true },
        });
        return row;
    }

    async markProcessed(id: bigint, data: { leadId: bigint | null; outcome: string; now: Date }): Promise<void> {
        await this.db.inboxEvent.update({
            where: { id },
            data: {
                status: 'PROCESSED',
                leadId: data.leadId,
                outcome: data.outcome,
                lastError: null,
                nextAttemptAt: null,
                processedAt: data.now,
            },
        });
    }

    async markFailed(id: bigint, data: { error: string; nextAttemptAt: Date }): Promise<void> {
        await this.db.inboxEvent.update({
            where: { id },
            data: { status: 'FAILED', lastError: data.error.slice(0, 500), nextAttemptAt: data.nextAttemptAt },
        });
    }

    async markDead(id: bigint, error: string): Promise<void> {
        await this.db.inboxEvent.update({
            where: { id },
            data: { status: 'DEAD', lastError: error.slice(0, 500), nextAttemptAt: null },
        });
    }

    /** Puts a failed or dead event back in line, with its tries counted from zero. */
    async reset(id: bigint, now: Date): Promise<boolean> {
        const result = await this.db.inboxEvent.updateMany({
            where: { id, status: { in: ['FAILED', 'DEAD'] }, payload: { not: Prisma.DbNull } },
            data: { status: 'RECEIVED', attempts: 0, lastError: null, nextAttemptAt: now },
        });
        return result.count > 0;
    }

    /** Events that are due for a try and that nobody is handling. */
    async findDue(now: Date, take: number): Promise<bigint[]> {
        const rows = await this.db.inboxEvent.findMany({
            where: { status: { in: ['RECEIVED', 'FAILED', 'PROCESSING'] }, nextAttemptAt: { lte: now } },
            orderBy: { id: 'asc' },
            take,
            select: { id: true },
        });
        return rows.map((r) => r.id);
    }

    /** Removes personal details from events processed long ago. */
    async purgePayloads(now: Date): Promise<number> {
        const before = new Date(now.getTime() - PAYLOAD_KEEP_DAYS * 86_400_000);
        const result = await this.db.inboxEvent.updateMany({
            where: { status: 'PROCESSED', processedAt: { lt: before }, payload: { not: Prisma.DbNull } },
            data: { payload: Prisma.DbNull },
        });
        return result.count;
    }

    async listRecent(filter: InboxStatusName[] | null, take: number): Promise<InboxListRow[]> {
        return this.db.inboxEvent.findMany({
            where: filter ? { status: { in: filter } } : {},
            orderBy: { id: 'desc' },
            take,
            select: {
                id: true,
                source: true,
                type: true,
                status: true,
                attempts: true,
                lastError: true,
                outcome: true,
                leadId: true,
                receivedAt: true,
            },
        });
    }

    async countByStatusSince(since: Date): Promise<Record<string, number>> {
        const groups = await this.db.inboxEvent.groupBy({
            by: ['status'],
            where: { receivedAt: { gte: since } },
            _count: { _all: true },
        });
        return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
    }

    /** Failed and dead events are counted over all time: they stay a problem until someone deals with them. */
    async countOpenProblems(): Promise<{ failed: number; dead: number }> {
        const [failed, dead] = await Promise.all([
            this.db.inboxEvent.count({ where: { status: 'FAILED' } }),
            this.db.inboxEvent.count({ where: { status: 'DEAD' } }),
        ]);
        return { failed, dead };
    }

    countCreatedSince(since: Date): Promise<number> {
        return this.db.inboxEvent.count({ where: { outcome: 'CREATED', processedAt: { gte: since } } });
    }

    async receivedTimesSince(source: SourceSystemName, since: Date): Promise<Date[]> {
        const rows = await this.db.inboxEvent.findMany({
            where: { source, receivedAt: { gte: since } },
            select: { receivedAt: true },
            orderBy: { receivedAt: 'desc' },
            take: 5000,
        });
        return rows.map((r) => r.receivedAt);
    }

    async lastReceivedAt(source: SourceSystemName): Promise<Date | null> {
        const row = await this.db.inboxEvent.findFirst({
            where: { source },
            orderBy: { receivedAt: 'desc' },
            select: { receivedAt: true },
        });
        return row?.receivedAt ?? null;
    }
}
