import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { AssignmentModule } from '@modules/assignment';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { PipelineModule } from '@modules/pipeline';
import { TimelineModule } from '@modules/timeline';
import { IMPORTS_QUEUE } from './imports.constants.js';
import { ImportsController } from './imports.controller.js';
import { ImportsQueue } from './imports.queue.js';
import { ImportsRepository } from './imports.repository.js';
import { ImportsService } from './imports.service.js';

/**
 * CSV upload, column mapping, dry run and commit.
 */
@Module({
    imports: [
        BullModule.registerQueue({ name: IMPORTS_QUEUE }),
        LeadsModule,
        PipelineModule,
        AssignmentModule,
        TimelineModule,
        IamModule,
        AdminModule,
    ],
    controllers: [ImportsController],
    providers: [ImportsRepository, ImportsService, ImportsQueue],
    exports: [ImportsService],
})
export class ImportsModule {}
