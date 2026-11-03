import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '@app/rbac';
import { AdminService } from './admin.service.js';

/**
 * Liveness and database check, used by the deploy script before it switches traffic.
 * Served at /health (outside the /api/v1 prefix). Redis is added when the queues arrive.
 */
@Public()
@Controller('health')
export class HealthController {
    constructor(private readonly admin: AdminService) {}

    @Get()
    async check(): Promise<{ status: 'ok' }> {
        try {
            await this.admin.checkDatabase();
        } catch {
            throw new ServiceUnavailableException({
                code: 'DB_UNAVAILABLE',
                message: 'Database is not reachable',
            });
        }
        return { status: 'ok' };
    }
}
