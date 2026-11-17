import { Injectable } from '@nestjs/common';
import { TimelineRepository } from './timeline.repository.js';
import type { NewTimelineEvent } from './timeline.types.js';

/** Told about events once they are written (the lead score listens). It must not throw; errors are its own to log. */
export type TimelineListener = (events: NewTimelineEvent[]) => Promise<void>;

@Injectable()
export class TimelineService {
    private readonly listeners: TimelineListener[] = [];

    constructor(private readonly repository: TimelineRepository) {}

    /** Runs `listener` after every event written from now on. */
    subscribe(listener: TimelineListener): void {
        this.listeners.push(listener);
    }

    private async written(events: NewTimelineEvent[]): Promise<void> {
        for (const listener of this.listeners) {
            try {
                await listener(events);
            } catch {
                // A listener's failure never undoes or blocks the change that wrote the event.
            }
        }
    }

    clearEventData(leadId: bigint): Promise<void> {
        return this.repository.clearEventData(leadId);
    }

    /** A merge: everything that happened to the duplicate shows on the kept lead. */
    moveEvents(fromLeadId: bigint, toLeadId: bigint): Promise<void> {
        return this.repository.moveEvents(fromLeadId, toLeadId);
    }

    /** Adds an event to a lead's history. */
    async append(event: NewTimelineEvent): Promise<void> {
        await this.repository.insert(event);
        await this.written([event]);
    }

    /** Adds several events to a lead's history in one write. */
    async appendMany(events: NewTimelineEvent[]): Promise<void> {
        await this.repository.insertMany(events);
        if (events.length > 0) await this.written(events);
    }

    /**
     * Adds the event unless the lead already has one of this type. For things that happen once
     * per lead (created, first assigned), so a retried job does not write them twice.
     */
    async appendOnce(event: NewTimelineEvent): Promise<void> {
        if (await this.repository.hasEvent(event.leadId, event.type)) return;
        await this.repository.insert(event);
        await this.written([event]);
    }
}
