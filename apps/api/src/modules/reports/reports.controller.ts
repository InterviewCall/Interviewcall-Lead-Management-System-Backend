import { Controller, Get, Query } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { type ReportQuery, reportQuerySchema } from './reports.schemas.js';
import { OperationsService } from './operations.service.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
export class ReportsController {
    constructor(
        private readonly reports: ReportsService,
        private readonly operations: OperationsService,
    ) {}

    /**
     * First-response time, stage aging and assignment fairness. A BDA gets their own first-response and aging
     * figures and no fairness table.
     */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('operations')
    operationsReport(@CurrentUser() auth: AuthContext, @Query({ schema: reportQuerySchema }) query: ReportQuery) {
        return this.operations.get(auth, query);
    }

    /** The Reports screen. A BDA's figures cover their own leads; everyone else's cover the team. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('summary')
    summary(@CurrentUser() auth: AuthContext, @Query({ schema: reportQuerySchema }) query: ReportQuery) {
        return this.reports.get(auth, query);
    }
}
