import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { AdminRepository } from './admin.repository.js';
import { AdminService } from './admin.service.js';

/**
 * Settings, audit log and health.
 */
@Module({
    imports: [],
    controllers: [HealthController],
    providers: [AdminRepository, AdminService],
    exports: [AdminService],
})
export class AdminModule {}
