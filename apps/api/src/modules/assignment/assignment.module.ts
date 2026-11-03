import { Module } from '@nestjs/common';
import { EngagementModule } from '@modules/engagement';
import { LeadsModule } from '@modules/leads';
import { TimelineModule } from '@modules/timeline';
import { IamModule } from '@modules/iam';
import { AdminModule } from '@modules/admin';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';

/**
 * Assign, reassign, distribute equally, the assignment log and the rotation cursor.
 */
@Module({
    imports: [
        EngagementModule,
        LeadsModule,
        TimelineModule,
        IamModule,
        AdminModule,
    ],
    providers: [AssignmentRepository, AssignmentService],
    exports: [AssignmentService],
})
export class AssignmentModule {}
