import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type { NewTimelineEvent } from './timeline.types.js';

/**
 * The only class allowed to read or write this module's tables:
 * lead_events.
 * Other modules call TimelineService instead of touching these models.
 */
@Injectable()
export class TimelineRepository {
    constructor(private readonly db: ModelService) {}

    async hasEvent(leadId: bigint, type: string): Promise<boolean> {
        const found = await this.db.leadEvent.findFirst({
            where: { leadId, type },
            select: { id: true },
        });
        return found !== null;
    }

    async insertMany(events: NewTimelineEvent[]): Promise<void> {
        if (events.length === 0) return;
        const now = new Date();
        await this.db.leadEvent.createMany({
            data: events.map((event) => ({
                leadId: event.leadId,
                type: event.type,
                actorType: event.actorType,
                actorId: event.actorId,
                data: (event.data ?? undefined) as Prisma.InputJsonValue | undefined,
                occurredAt: event.occurredAt ?? now,
            })),
        });
    }

    async insert(event: NewTimelineEvent): Promise<void> {
        await this.db.leadEvent.create({
            data: {
                leadId: event.leadId,
                type: event.type,
                actorType: event.actorType,
                actorId: event.actorId,
                data: (event.data ?? undefined) as Prisma.InputJsonValue | undefined,
                occurredAt: event.occurredAt ?? new Date(),
            },
        });
    }
}
