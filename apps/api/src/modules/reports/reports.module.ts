import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service.js';

/**
 * Read-only queries across all tables, through a read-only MySQL user. Owns no tables.
 */
@Module({
    imports: [],
    providers: [ReportsService],
    exports: [ReportsService],
})
export class ReportsModule {}
