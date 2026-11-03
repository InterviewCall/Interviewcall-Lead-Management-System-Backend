import { Module } from '@nestjs/common';
import { ModelModule } from '@app/model';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { EngagementModule } from '@modules/engagement';
import { AssignmentModule } from '@modules/assignment';
import { TimelineModule } from '@modules/timeline';
import { IntakeModule } from '@modules/intake';
import { ImportsModule } from '@modules/imports';
import { ReportsModule } from '@modules/reports';
import { AdminModule } from '@modules/admin';

/**
 * Same modules as crm-api, started without an HTTP server. BullMQ processors for intake events
 * and CSV imports, and the nightly timers, are registered here as they are built.
 */
@Module({
    imports: [
        ModelModule,
        IamModule,
        LeadsModule,
        PipelineModule,
        EngagementModule,
        AssignmentModule,
        TimelineModule,
        IntakeModule,
        ImportsModule,
        ReportsModule,
        AdminModule,
    ],
})
export class WorkerModule {}
