import { Injectable } from '@nestjs/common';
import { TimelineRepository } from './timeline.repository.js';
import type { NewTimelineEvent } from './timeline.types.js';

@Injectable()
export class TimelineService {
    constructor(private readonly repository: TimelineRepository) {}

    /** Adds an event to a lead's history. */
    append(event: NewTimelineEvent): Promise<void> {
        return this.repository.insert(event);
    }

    /** Adds several events to a lead's history in one write. */
    appendMany(events: NewTimelineEvent[]): Promise<void> {
        return this.repository.insertMany(events);
    }

    /**
     * Adds the event unless the lead already has one of this type. For things that happen once
     * per lead (created, first assigned), so a retried job does not write them twice.
     */
    async appendOnce(event: NewTimelineEvent): Promise<void> {
        if (await this.repository.hasEvent(event.leadId, event.type)) return;
        await this.repository.insert(event);
    }
}
