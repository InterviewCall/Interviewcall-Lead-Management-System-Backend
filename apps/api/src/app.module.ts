import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
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
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { createValidationPipe } from './common/validation.js';

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
    providers: [
        // Validates every @Body({ schema }) / @Query({ schema }) and shapes all errors as { code, message, fields? }.
        { provide: APP_PIPE, useFactory: createValidationPipe },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
    ],
})
export class AppModule {}
