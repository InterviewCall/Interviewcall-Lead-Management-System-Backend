import { Module } from '@nestjs/common';
import { PipelineModule } from '@modules/pipeline';
import { LeadsModule } from '@modules/leads';
import { TimelineModule } from '@modules/timeline';
import { IamModule } from '@modules/iam';
import { EngagementRepository } from './engagement.repository.js';
import { EngagementService } from './engagement.service.js';

/**
 * Activities and outcomes, tasks, in-app notifications and the My work view.
 */
@Module({
    imports: [PipelineModule, LeadsModule, TimelineModule, IamModule],
    providers: [EngagementRepository, EngagementService],
    exports: [EngagementService],
})
export class EngagementModule {}
