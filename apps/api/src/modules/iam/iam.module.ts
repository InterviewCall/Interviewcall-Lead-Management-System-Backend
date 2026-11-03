import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { IamRepository } from './iam.repository.js';
import { IamService } from './iam.service.js';

/**
 * Login, sessions, staff users, role guards and API credentials for the three source services.
 */
@Module({
    imports: [AdminModule],
    providers: [IamRepository, IamService],
    exports: [IamService],
})
export class IamModule {}
