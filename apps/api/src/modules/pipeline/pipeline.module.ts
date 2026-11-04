import { Module } from '@nestjs/common';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { TimelineModule } from '@modules/timeline';
import { PipelineController } from './pipeline.controller.js';
import { PipelineRepository } from './pipeline.repository.js';
import { PipelineService } from './pipeline.service.js';

/**
 * Opportunities, stage moves, close as won or lost, lost reasons.
 */
@Module({
    imports: [IamModule, LeadsModule, TimelineModule],
    controllers: [PipelineController],
    providers: [PipelineRepository, PipelineService],
    exports: [PipelineService],
})
export class PipelineModule {}
