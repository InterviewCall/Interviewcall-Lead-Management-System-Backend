import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { AssignmentModule } from '@modules/assignment';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { TimelineModule } from '@modules/timeline';
import { CaptureController } from './capture.controller.js';
import { CaptureService } from './capture.service.js';

/**
 * Leads added by hand. A module of its own because a new lead also needs an opportunity and an assignment log
 * line, and the leads module sits below both.
 */
@Module({
    imports: [LeadsModule, PipelineModule, AssignmentModule, TimelineModule, IamModule, AdminModule],
    controllers: [CaptureController],
    providers: [CaptureService],
})
export class CaptureModule {}
