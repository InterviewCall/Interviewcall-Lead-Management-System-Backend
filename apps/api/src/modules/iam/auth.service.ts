import { randomUUID } from 'node:crypto';
import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { AdminService, AuditAction } from '@modules/admin';
import type { AuthContext } from '@app/rbac';
import { toSessionUser, unauthenticated } from './auth.errors.js';
import type { ChangePasswordBody, LoginBody } from './auth.schemas.js';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import { IamRepository } from './iam.repository.js';
import type {
    NewSession,
    RequestMeta,
    SessionUser,
    StaffAccount,
} from './iam.types.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

export interface SessionTokens {
    access: string;
    refresh: string;
    csrf: string;
}

export interface LoginResult {
    user: SessionUser;
    tokens: SessionTokens;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly repository: IamRepository,
        private readonly passwords: PasswordService,
        private readonly tokens: TokenService,
        private readonly admin: AdminService,
        @Inject(IAM_CONFIG) private readonly config: IamConfig,
    ) {}

    async login(input: LoginBody, meta: RequestMeta): Promise<LoginResult> {
        const now = new Date();
        const account = await this.repository.findStaffByEmail(input.email);

        // Unknown and deactivated accounts get the same answer, in the same time, as a wrong password.
        if (!account || !account.isActive) {
            await this.passwords.burn(input.password);
            await this.admin.audit({
                action: AuditAction.LoginFailed,
                actorId: null,
                entityType: 'staff',
                entityId: account?.publicId ?? null,
                detail: { reason: account ? 'deactivated' : 'unknown_account' },
                ip: meta.ip ?? null,
            });
            throw this.invalidCredentials();
        }

        // While locked the password is not checked at all, so a lock cannot be used to test guesses.
        this.requireNotLocked(account, now);

        if (
            !(await this.passwords.verify(account.passwordHash, input.password))
        ) {
            await this.recordFailure(
                account,
                now,
                meta,
                AuditAction.LoginFailed,
            );
            throw this.invalidCredentials();
        }

        const { session, tokens } = await this.openSession(
            account,
            account.mustChangePassword,
            meta,
            now,
        );
        await this.repository.recordSuccessfulLogin(account.id, session, now);
        await this.admin.audit({
            action: AuditAction.LoginSucceeded,
            actorId: account.id,
            entityType: 'staff',
            entityId: account.publicId,
            ip: meta.ip ?? null,
        });

        return { user: toSessionUser(account), tokens };
    }

    /**
     * Lets a signed-in user replace their password (this is also how a temporary password stops
     * being one). Every earlier session ends and a fresh one is returned, so the caller stays
     * signed in. The current password is checked first and counts toward the same lock as login.
     */
    async changePassword(
        auth: AuthContext,
        input: ChangePasswordBody,
        meta: RequestMeta,
    ): Promise<LoginResult> {
        const now = new Date();
        const account = await this.repository.findStaffByPublicId(
            auth.publicId,
        );
        if (!account || !account.isActive) {
            throw unauthenticated();
        }

        this.requireNotLocked(account, now);

        if (
            !(await this.passwords.verify(
                account.passwordHash,
                input.currentPassword,
            ))
        ) {
            await this.recordFailure(
                account,
                now,
                meta,
                AuditAction.PasswordChangeFailed,
            );
            // 400, not 401: the session is fine, only this field is wrong, and a 401 would sign the user out.
            throw new BadRequestException({
                code: 'VALIDATION_FAILED',
                message: 'Some fields are invalid',
                fields: { currentPassword: 'Current password is incorrect' },
            });
        }

        const passwordHash = await this.passwords.hash(input.newPassword);
        const { session, tokens } = await this.openSession(
            account,
            false,
            meta,
            now,
        );
        await this.repository.changePassword(
            account.id,
            passwordHash,
            session,
            now,
        );
        await this.admin.audit({
            action: AuditAction.PasswordChanged,
            actorId: account.id,
            entityType: 'staff',
            entityId: account.publicId,
            ip: meta.ip ?? null,
        });

        return { user: toSessionUser(account, false), tokens };
    }

    /** Builds a new session family and its tokens. Signs first, so a failure leaves no session row. */
    private async openSession(
        account: StaffAccount,
        mustChangePassword: boolean,
        meta: RequestMeta,
        now: Date,
    ): Promise<{ session: NewSession; tokens: SessionTokens }> {
        const familyId = randomUUID();
        const refresh = this.tokens.newRefreshToken();
        const access = await this.tokens.signAccessToken({
            publicId: account.publicId,
            role: account.role,
            familyId,
            mustChangePassword,
        });

        return {
            session: {
                tokenHash: refresh.hash,
                familyId,
                userAgent: meta.userAgent?.slice(0, 255) ?? null,
                ip: meta.ip?.slice(0, 45) ?? null,
                expiresAt: new Date(now.getTime() + this.config.refreshTtlMs),
            },
            tokens: {
                access,
                refresh: refresh.token,
                csrf: this.tokens.newCsrfToken(),
            },
        };
    }

    private requireNotLocked(account: StaffAccount, now: Date): void {
        if (account.lockedUntil && account.lockedUntil > now) {
            throw this.accountLocked(account.lockedUntil, now);
        }
    }

    /** Counts a wrong password toward the lock and records it. Never records the password. */
    private async recordFailure(
        account: StaffAccount,
        now: Date,
        meta: RequestMeta,
        action:
            | typeof AuditAction.LoginFailed
            | typeof AuditAction.PasswordChangeFailed,
    ): Promise<void> {
        const locked = await this.repository.recordFailedLogin(account.id, {
            maxAttempts: this.config.maxFailedLogins,
            lockUntil: new Date(now.getTime() + this.config.lockMs),
        });
        await this.admin.audit({
            action,
            actorId: account.id,
            entityType: 'staff',
            entityId: account.publicId,
            detail: { reason: 'wrong_password' },
            ip: meta.ip ?? null,
        });
        if (locked) {
            await this.admin.audit({
                action: AuditAction.AccountLocked,
                actorId: account.id,
                entityType: 'staff',
                entityId: account.publicId,
                ip: meta.ip ?? null,
            });
        }
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
