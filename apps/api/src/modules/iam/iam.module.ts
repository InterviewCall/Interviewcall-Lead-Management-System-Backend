import { Module } from '@nestjs/common';
import { AdminModule } from '@modules/admin';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { IAM_CONFIG, loadIamConfig } from './iam.config.js';
import { IamRepository } from './iam.repository.js';
import { IamService } from './iam.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/**
 * Login, sessions, staff users, role guards and API credentials for the three source services.
 */
@Module({
    imports: [AdminModule],
    controllers: [AuthController],
    providers: [
        { provide: IAM_CONFIG, useFactory: () => loadIamConfig() },
        IamRepository,
        IamService,
        AuthService,
        PasswordService,
        TokenService,
    ],
    exports: [IamService],
})
export class IamModule {}
