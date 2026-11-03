import { Module } from '@nestjs/common';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { EngagementModule } from '@modules/engagement';
import { TimelineModule } from '@modules/timeline';
import { IntakeRepository } from './intake.repository.js';
import { IntakeService } from './intake.service.js';

/**
 * Accept source events, make them idempotent, apply them, nightly reconciliation, suppression lookup and the WorkR nurture read-through.
 */
@Module({
    imports: [LeadsModule, PipelineModule, EngagementModule, TimelineModule],
    providers: [IntakeRepository, IntakeService],
    exports: [IntakeService],
})
export class IntakeModule {}
