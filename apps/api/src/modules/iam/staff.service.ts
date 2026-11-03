import {
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { AdminService, AuditAction } from '@modules/admin';
import type { AuthContext } from '@app/rbac';
import { NotificationService } from '@notifications';
import { unauthenticated } from './auth.errors.js';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import { IamRepository } from './iam.repository.js';
import type {
    RequestMeta,
    Role,
    StaffAccount,
    StaffChanges,
    StaffListItem,
    StaffListRecord,
    StaffRecord,
    StaffStatus,
    StaffView,
} from './iam.types.js';
import type {
    CreateStaffBody,
    ListStaffQuery,
    UpdateStaffBody,
} from './staff.schemas.js';
import { PasswordService } from './password.service.js';

const ROLE_LABELS: Record<Role, string> = {
    BDA: 'BDA',
    SALES_MANAGER: 'Sales Manager',
    CLOSER: 'Closer',
    OPS: 'Ops',
    ADMIN: 'Admin',
};

/**
 * Staff administration. Every method is for admins: the controller checks the role in the token,
 * and each method checks it again against the database, so a demoted or deactivated admin is
 * stopped at once instead of when their access token expires.
 */
@Injectable()
export class StaffService {
    private readonly logger = new Logger(StaffService.name);

    constructor(
        private readonly repository: IamRepository,
        private readonly passwords: PasswordService,
        private readonly notifications: NotificationService,
        private readonly admin: AdminService,
        @Inject(IAM_CONFIG) private readonly config: IamConfig,
    ) {}

    async list(
        auth: AuthContext,
        query: ListStaffQuery,
    ): Promise<{
        staff: StaffListItem[];
        page: number;
        pageSize: number;
        total: number;
    }> {
        await this.requireAdmin(auth);
        const { items, total } = await this.repository.listStaff({
            ...query,
            search: query.search || undefined,
        });
        return {
            staff: items.map(toListItem),
            page: query.page,
            pageSize: query.pageSize,
            total,
        };
    }

    /**
     * Creates a staff account with a one-time password and emails it to them. The password is shown
     * to nobody else, not even the admin. If the email cannot be queued the account is removed
     * again, so an account is never left that nobody can sign in to.
     */
    async create(
        auth: AuthContext,
        input: CreateStaffBody,
        meta: RequestMeta,
    ): Promise<StaffView> {
        const actor = await this.requireAdmin(auth);
        const temporaryPassword = this.passwords.generateTemporary();
        const staff = await this.repository.createStaff({
            ...input,
            passwordHash: await this.passwords.hash(temporaryPassword),
        });
        if (!staff) {
            throw new ConflictException({
                code: 'EMAIL_ALREADY_EXISTS',
                message: 'A staff account with this email already exists',
            });
        }

        try {
            await this.sendTemporaryPassword(staff, temporaryPassword);
        } catch (error) {
            this.logger.error(
                `Could not queue the invite email: ${describe(error)}`,
            );
            await this.repository
                .deleteStaff(staff.id)
                .catch((cleanupError: unknown) => {
                    this.logger.error(
                        `Could not remove the account after a failed invite: ${describe(cleanupError)}`,
                    );
                });
            throw this.queueUnavailable();
        }

        await this.admin.audit({
            action: AuditAction.StaffCreated,
            actorId: actor.id,
            entityType: 'staff',
            entityId: staff.publicId,
            detail: { role: staff.role },
            ip: meta.ip ?? null,
        });
        return toView(staff);
    }

    /**
     * Changes an account's name or role. Admins cannot change their own role, so there is always
     * an admin who can undo a mistake. The new role reaches the person's access token at their
     * next refresh (within the access token lifetime).
     */
    async update(
        auth: AuthContext,
        publicId: string,
        input: UpdateStaffBody,
        meta: RequestMeta,
    ): Promise<StaffView> {
        const actor = await this.requireAdmin(auth);
        const target = await this.requireStaff(publicId);

        const changes: StaffChanges = {};
        if (input.name !== undefined && input.name !== target.name) {
            changes.name = input.name;
        }
        if (input.role !== undefined && input.role !== target.role) {
            if (target.id === actor.id) {
                throw new ConflictException({
                    code: 'CANNOT_CHANGE_OWN_ROLE',
                    message: 'You cannot change your own role',
                });
            }
            changes.role = input.role;
        }
        if (Object.keys(changes).length === 0) {
            return toView(target);
        }

        const updated = await this.repository.updateStaff(target.id, changes);
        await this.admin.audit({
            action: AuditAction.StaffUpdated,
            actorId: actor.id,
            entityType: 'staff',
            entityId: target.publicId,
            detail: {
                fields: Object.keys(changes),
                ...(changes.role
                    ? { role: { from: target.role, to: changes.role } }
                    : {}),
            },
            ip: meta.ip ?? null,
        });
        return toView(updated);
    }

    /**
     * Switches an account off and ends all its sessions. Their access token keeps working for at
     * most its remaining lifetime, but admin routes refuse it at once and a refresh is refused.
     * Admins cannot deactivate themselves. Deactivating a deactivated account does nothing.
     */
    async deactivate(
        auth: AuthContext,
        publicId: string,
        meta: RequestMeta,
    ): Promise<StaffView> {
        const actor = await this.requireAdmin(auth);
        const target = await this.requireStaff(publicId);
        if (target.id === actor.id) {
            throw new ConflictException({
                code: 'CANNOT_DEACTIVATE_SELF',
                message: 'You cannot deactivate your own account',
            });
        }
        if (!target.isActive) {
            return toView(target);
        }

        const updated = await this.repository.deactivateStaff(
            target.id,
            new Date(),
        );
        await this.admin.audit({
            action: AuditAction.StaffDeactivated,
            actorId: actor.id,
            entityType: 'staff',
            entityId: target.publicId,
            ip: meta.ip ?? null,
        });
        return toView(updated);
    }

    /**
     * Switches a deactivated account back on. It comes back pending with a new one-time password
     * (emailed), never with its old password. If the email cannot be queued the account goes back
     * to deactivated.
     */
    async reactivate(
        auth: AuthContext,
        publicId: string,
        meta: RequestMeta,
    ): Promise<StaffView> {
        const actor = await this.requireAdmin(auth);
        const target = await this.requireStaff(publicId);
        if (target.isActive) {
            throw new ConflictException({
                code: 'STAFF_ALREADY_ACTIVE',
                message: 'This account is already active',
            });
        }

        const temporaryPassword = this.passwords.generateTemporary();
        const updated = await this.repository.reactivateStaff(
            target.id,
            await this.passwords.hash(temporaryPassword),
        );
        try {
            await this.sendTemporaryPassword(updated, temporaryPassword);
        } catch (error) {
            this.logger.error(
                `Could not queue the reactivation email: ${describe(error)}`,
            );
            await this.repository
                .deactivateStaff(target.id, new Date())
                .catch((cleanupError: unknown) => {
                    this.logger.error(
                        `Could not switch the account back off after a failed email: ${describe(cleanupError)}`,
                    );
                });
            throw this.queueUnavailable();
        }

        await this.admin.audit({
            action: AuditAction.StaffReactivated,
            actorId: actor.id,
            entityType: 'staff',
            entityId: target.publicId,
            ip: meta.ip ?? null,
        });
        return toView(updated);
    }

    /**
     * Issues a new one-time password: the old password stops working, every session ends, the
     * account is pending again and the new password is emailed. If queuing fails the admin just
     * runs it again.
     */
    async resetPassword(
        auth: AuthContext,
        publicId: string,
        meta: RequestMeta,
    ): Promise<StaffView> {
        const actor = await this.requireAdmin(auth);
        const account = await this.requireStaff(publicId);
        if (!account.isActive) {
            throw new ConflictException({
                code: 'STAFF_DEACTIVATED',
                message: 'This account is deactivated',
            });
        }

        const temporaryPassword = this.passwords.generateTemporary();
        await this.repository.setTemporaryPassword(
            account.id,
            await this.passwords.hash(temporaryPassword),
            new Date(),
        );
        // Recorded now: the password has changed whether or not the email gets queued.
        await this.admin.audit({
            action: AuditAction.StaffPasswordReset,
            actorId: actor.id,
            entityType: 'staff',
            entityId: account.publicId,
            ip: meta.ip ?? null,
        });

        const staff: StaffRecord = { ...account, mustChangePassword: true };
        try {
            await this.sendTemporaryPassword(staff, temporaryPassword);
        } catch (error) {
            this.logger.error(
                `Could not queue the reset email: ${describe(error)}`,
            );
            throw this.queueUnavailable();
        }

        return toView(staff);
    }

    /** The acting admin, checked against the database rather than the token. */
    private async requireAdmin(auth: AuthContext): Promise<StaffAccount> {
        const actor = await this.repository.findStaffByPublicId(auth.publicId);
        if (!actor || !actor.isActive) {
            throw unauthenticated();
        }
        if (actor.role !== 'ADMIN') {
            throw new ForbiddenException({
                code: 'FORBIDDEN',
                message: 'You do not have access to this',
            });
        }
        return actor;
    }

    private async requireStaff(publicId: string): Promise<StaffAccount> {
        const account = await this.repository.findStaffByPublicId(publicId);
        if (!account) {
            throw new NotFoundException({
                code: 'STAFF_NOT_FOUND',
                message: 'Staff account not found',
            });
        }
        return account;
    }

    private sendTemporaryPassword(
        staff: StaffRecord,
        temporaryPassword: string,
    ): Promise<void> {
        return this.notifications.enqueue({
            channel: 'EMAIL',
            recipient: staff.email,
            template: 'staff-invite',
            data: {
                name: staff.name,
                role: ROLE_LABELS[staff.role],
                email: staff.email,
                temporaryPassword,
                loginUrl: `${this.config.webOrigin}/login`,
            },
        });
    }

    private queueUnavailable(): HttpException {
        return new HttpException(
            {
                code: 'EMAIL_QUEUE_UNAVAILABLE',
                message: 'Could not queue the email. Try again in a moment.',
            },
            HttpStatus.SERVICE_UNAVAILABLE,
        );
    }
}

function statusOf(staff: StaffRecord): StaffStatus {
    if (!staff.isActive) return 'DEACTIVATED';
    return staff.mustChangePassword ? 'PENDING' : 'ACTIVE';
}

function toView(staff: StaffRecord): StaffView {
    return {
        id: staff.publicId,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        status: statusOf(staff),
    };
}

function toListItem(staff: StaffListRecord): StaffListItem {
    return {
        ...toView(staff),
        createdAt: staff.createdAt.toISOString(),
        lastLoginAt: staff.lastLoginAt?.toISOString() ?? null,
    };
}

/** An error's name and message: enough to debug, without the message payload. */
function describe(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}
