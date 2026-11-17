import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { IamModule } from '@modules/iam';
import { OperationsService } from './operations.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

/**
 * Read-only queries across all tables. Owns no tables and writes nothing; every query is a SELECT.
 */
@Module({
    imports: [IamModule, AdminModule],
    controllers: [ReportsController],
    providers: [ReportsRepository, ReportsService, OperationsService],
    exports: [ReportsService],
})
export class ReportsModule {}
