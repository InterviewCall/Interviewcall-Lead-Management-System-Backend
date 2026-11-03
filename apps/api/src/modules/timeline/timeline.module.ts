import { Module } from '@nestjs/common';
import { TimelineRepository } from './timeline.repository.js';
import { TimelineService } from './timeline.service.js';

/**
 * Append and read the lead event history.
 */
@Module({
    imports: [],
    providers: [TimelineRepository, TimelineService],
    exports: [TimelineService],
})
export class TimelineModule {}
