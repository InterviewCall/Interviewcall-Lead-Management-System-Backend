import { randomUUID } from 'node:crypto';
import {
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { LoginBody } from './auth.schemas.js';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import { IamRepository } from './iam.repository.js';
import type { SessionUser } from './iam.types.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

export interface RequestMeta {
    ip: string | undefined;
    userAgent: string | undefined;
}

export interface LoginResult {
    user: SessionUser;
    tokens: { access: string; refresh: string; csrf: string };
}

@Injectable()
export class AuthService {
    constructor(
        private readonly repository: IamRepository,
        private readonly passwords: PasswordService,
        private readonly tokens: TokenService,
        @Inject(IAM_CONFIG) private readonly config: IamConfig,
    ) {}

    async login(input: LoginBody, meta: RequestMeta): Promise<LoginResult> {
        const now = new Date();
        const account = await this.repository.findStaffByEmail(input.email);

        // Unknown and deactivated accounts get the same answer, in the same time, as a wrong password.
        if (!account || !account.isActive) {
            await this.passwords.burn(input.password);
            throw this.invalidCredentials();
        }

        // While locked the password is not checked at all, so a lock cannot be used to test guesses.
        if (account.lockedUntil && account.lockedUntil > now) {
            throw this.accountLocked(account.lockedUntil, now);
        }

        if (
            !(await this.passwords.verify(account.passwordHash, input.password))
        ) {
            await this.repository.recordFailedLogin(account.id, {
                maxAttempts: this.config.maxFailedLogins,
                lockUntil: new Date(now.getTime() + this.config.lockMs),
            });
            throw this.invalidCredentials();
        }

        const familyId = randomUUID();
        const refresh = this.tokens.newRefreshToken();
        // Sign first: if it fails, no session row is left behind.
        const access = await this.tokens.signAccessToken({
            publicId: account.publicId,
            role: account.role,
            familyId,
        });

        await this.repository.recordSuccessfulLogin(
            account.id,
            {
                tokenHash: refresh.hash,
                familyId,
                userAgent: meta.userAgent?.slice(0, 255) ?? null,
                ip: meta.ip?.slice(0, 45) ?? null,
                expiresAt: new Date(now.getTime() + this.config.refreshTtlMs),
            },
            now,
        );

        return {
            user: {
                id: account.publicId,
                name: account.name,
                email: account.email,
                role: account.role,
                mustChangePassword: account.mustChangePassword,
            },
            tokens: {
                access,
                refresh: refresh.token,
                csrf: this.tokens.newCsrfToken(),
            },
        };
    }

    private invalidCredentials(): UnauthorizedException {
        return new UnauthorizedException({
            code: 'INVALID_CREDENTIALS',
            message: 'Email or password is incorrect',
        });
    }

    private accountLocked(lockedUntil: Date, now: Date): HttpException {
        const minutes = Math.max(
            1,
            Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000),
        );
        return new HttpException(
            {
                code: 'ACCOUNT_LOCKED',
                message: `Too many failed attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
            },
            HttpStatus.LOCKED,
        );
    }
}
