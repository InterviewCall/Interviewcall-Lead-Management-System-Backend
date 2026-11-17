import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { PipelineModule } from '@modules/pipeline';
import { LeadsModule } from '@modules/leads';
import { TimelineModule } from '@modules/timeline';
import { IamModule } from '@modules/iam';
import { EngagementController } from './engagement.controller.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { EngagementRepository } from './engagement.repository.js';
import { EngagementService } from './engagement.service.js';

/**
 * Activities and outcomes, tasks, in-app notifications and the My work view.
 */
@Module({
    imports: [AdminModule, PipelineModule, LeadsModule, TimelineModule, IamModule],
    controllers: [EngagementController, InboxController],
    providers: [EngagementRepository, EngagementService, InboxService],
    exports: [EngagementService, InboxService],
})
export class EngagementModule {}
