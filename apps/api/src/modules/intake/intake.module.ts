import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AssignmentModule } from '@modules/assignment';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { TimelineModule } from '@modules/timeline';
import { INTAKE_QUEUE } from './intake.constants.js';
import { IntakeAdminController } from './intake-admin.controller.js';
import { IntakeController } from './intake.controller.js';
import { IntakeQueue } from './intake.queue.js';
import { IntakeRepository } from './intake.repository.js';
import { IntakeService } from './intake.service.js';
import { SourceKeyGuard } from './source-key.guard.js';
import { VslIntakeService } from './vsl-intake.service.js';

/**
 * Accept source events, make them idempotent, apply them (a WorkR signup becomes a lead owned by
 * the intake owner, in the day's list), and show them on the Intake monitor.
 */
@Module({
    imports: [
        BullModule.registerQueue({ name: INTAKE_QUEUE }),
        LeadsModule,
        PipelineModule,
        AssignmentModule,
        TimelineModule,
        IamModule,
    ],
    controllers: [IntakeController, IntakeAdminController],
    providers: [IntakeRepository, IntakeQueue, IntakeService, VslIntakeService, SourceKeyGuard],
    exports: [IntakeService],
})
export class IntakeModule {}
