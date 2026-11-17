import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { AssignmentModule } from '@modules/assignment';
import { EngagementModule } from '@modules/engagement';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { TimelineModule } from '@modules/timeline';
import { MergeController } from './merge.controller.js';
import { MergeService } from './merge.service.js';

/** Merging duplicate leads. Its own module because a merge touches every module that holds records about a lead. */
@Module({
    imports: [LeadsModule, PipelineModule, EngagementModule, AssignmentModule, TimelineModule, IamModule, AdminModule],
    controllers: [MergeController],
    providers: [MergeService],
})
export class MergeModule {}
