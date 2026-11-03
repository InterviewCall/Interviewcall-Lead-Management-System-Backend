import { Module } from '@nestjs/common';
import { LeadsModule } from '@modules/leads';
import { TimelineModule } from '@modules/timeline';
import { PipelineRepository } from './pipeline.repository.js';
import { PipelineService } from './pipeline.service.js';

/**
 * Opportunities, stage moves, close as won or lost, lost reasons.
 */
@Module({
    imports: [LeadsModule, TimelineModule],
    providers: [PipelineRepository, PipelineService],
    exports: [PipelineService],
})
export class PipelineModule {}
