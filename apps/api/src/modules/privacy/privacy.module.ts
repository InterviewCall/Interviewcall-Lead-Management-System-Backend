import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { EngagementModule } from '@modules/engagement';
import { IamModule } from '@modules/iam';
import { ImportsModule } from '@modules/imports';
import { IntakeModule } from '@modules/intake';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { TimelineModule } from '@modules/timeline';
import { PrivacyController } from './privacy.controller.js';
import { PrivacyService } from './privacy.service.js';

/** Erasing a person's details on request (DPDP). Its own module because every module holds some of them. */
@Module({
    imports: [LeadsModule, PipelineModule, EngagementModule, IntakeModule, ImportsModule, TimelineModule, IamModule, AdminModule],
    controllers: [PrivacyController],
    providers: [PrivacyService],
})
export class PrivacyModule {}
