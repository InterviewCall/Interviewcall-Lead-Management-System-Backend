import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type {
    NewSession,
    NewStaff,
    SessionLookup,
    StaffAccount,
    StaffChanges,
    StaffListFilter,
    StaffPage,
    StaffRecord,
} from './iam.types.js';

const ACCOUNT_SELECT = {
    id: true,
    publicId: true,
    name: true,
    email: true,
    passwordHash: true,
    role: true,
    isActive: true,
    mustChangePassword: true,
    lockedUntil: true,
} as const;

const RECORD_SELECT = {
    id: true,
    publicId: true,
    name: true,
    email: true,
    role: true,
    isActive: true,
    mustChangePassword: true,
} as const;

const LIST_SELECT = {
    ...RECORD_SELECT,
    createdAt: true,
    lastLoginAt: true,
} as const;

/**
 * The only class allowed to read or write this module's tables:
 * staff_users, auth_sessions, source_credentials.
 * Other modules call IamService instead of touching these models.
 */
@Injectable()
export class IamRepository {
    constructor(private readonly db: ModelService) {}

    /** Emails are stored lower-case; the caller passes a normalised address. */
    findStaffByEmail(email: string): Promise<StaffAccount | null> {
        return this.db.staffUser.findUnique({
            where: { email },
            select: ACCOUNT_SELECT,
        });
    }

    findStaffByPublicId(publicId: string): Promise<StaffAccount | null> {
        return this.db.staffUser.findUnique({
            where: { publicId },
            select: ACCOUNT_SELECT,
        });
    }

    /** Creates the account, or returns null if the email is already taken. */
    async createStaff(staff: NewStaff): Promise<StaffRecord | null> {
        try {
            return await this.db.staffUser.create({
                // A new account starts with a temporary password: it is pending until it is changed.
                data: { ...staff, isActive: true, mustChangePassword: true },
                select: RECORD_SELECT,
            });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                return null;
            }
            throw error;
        }
    }

    /** Removes an account that was created a moment ago and could not be notified. */
    async deleteStaff(userId: bigint): Promise<void> {
        await this.db.staffUser.deleteMany({ where: { id: userId } });
    }

    /**
     * Counts one failed password. When the count reaches `maxAttempts` the account is locked
     * until `lockUntil` and the counter starts again from zero. Returns true if it just locked.
     */
    recordFailedLogin(
        userId: bigint,
        rule: { maxAttempts: number; lockUntil: Date },
    ): Promise<boolean> {
        return this.db.$transaction(async (tx) => {
            const { failedLogins } = await tx.staffUser.update({
                where: { id: userId },
                data: { failedLogins: { increment: 1 } },
                select: { failedLogins: true },
            });
            if (failedLogins < rule.maxAttempts) {
                return false;
            }
            await tx.staffUser.update({
                where: { id: userId },
                data: { failedLogins: 0, lockedUntil: rule.lockUntil },
            });
            return true;
        });
    }

    /** Clears the failure count and lock, stamps the login and stores the new session, as one write. */
    async recordSuccessfulLogin(
        userId: bigint,
        session: NewSession,
        now: Date,
    ): Promise<void> {
        await this.db.staffUser.update({
            where: { id: userId },
            data: {
                failedLogins: 0,
                lockedUntil: null,
                lastLoginAt: now,
                sessions: { create: session },
            },
        });
    }

    /**
     * Replaces the password with a new temporary one: the account is pending again, any lock is
     * cleared and every session ends, all in one transaction.
     */
    async setTemporaryPassword(
        userId: bigint,
        passwordHash: string,
        now: Date,
    ): Promise<void> {
        await this.db.$transaction([
            this.db.authSession.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: now },
            }),
            this.db.staffUser.update({
                where: { id: userId },
                data: {
                    passwordHash,
                    mustChangePassword: true,
                    failedLogins: 0,
                    lockedUntil: null,
                },
            }),
        ]);
    }

    /**
     * Stores the password the user chose: the account is no longer pending, every earlier session
     * ends, and the new session is created. One transaction, run in this order.
     */
    async changePassword(
        userId: bigint,
        passwordHash: string,
        session: NewSession,
        now: Date,
    ): Promise<void> {
        await this.db.$transaction([
            this.db.authSession.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: now },
            }),
            this.db.staffUser.update({
                where: { id: userId },
                data: {
                    passwordHash,
                    mustChangePassword: false,
                    failedLogins: 0,
                    lockedUntil: null,
                    sessions: { create: session },
                },
            }),
        ]);
    }

    /** Finds a refresh-token session by the hash of its token, with its account. */
    async findSessionByTokenHash(
        tokenHash: string,
    ): Promise<SessionLookup | null> {
        const row = await this.db.authSession.findUnique({
            where: { tokenHash },
            select: {
                id: true,
                userId: true,
                familyId: true,
                expiresAt: true,
                revokedAt: true,
                user: { select: ACCOUNT_SELECT },
            },
        });
        if (!row) {
            return null;
        }
        const { user, ...session } = row;
        return { session, account: user };
    }

    /**
     * Replaces a refresh token with its successor: the old row is revoked and the new one stored,
     * together. Returns false, changing nothing, if the old token was already revoked, which means
     * another request used it first.
     */
    rotateSession(
        oldSessionId: bigint,
        userId: bigint,
        next: NewSession,
        now: Date,
    ): Promise<boolean> {
        return this.db.$transaction(async (tx) => {
            const { count } = await tx.authSession.updateMany({
                where: { id: oldSessionId, revokedAt: null },
                data: { revokedAt: now },
            });
            if (count === 0) {
                return false;
            }
            await tx.authSession.create({ data: { ...next, userId } });
            return true;
        });
    }

    /** Ends every token of one sign-in (a family). Returns how many were still live. */
    async revokeFamily(familyId: string, now: Date): Promise<number> {
        const { count } = await this.db.authSession.updateMany({
            where: { familyId, revokedAt: null },
            data: { revokedAt: now },
        });
        return count;
    }

    /** True while the sign-in still has a live, unexpired refresh token. */
    async familyHasActiveSession(
        familyId: string,
        now: Date,
    ): Promise<boolean> {
        const live = await this.db.authSession.count({
            where: { familyId, revokedAt: null, expiresAt: { gt: now } },
        });
        return live > 0;
    }

    async listStaff(filter: StaffListFilter): Promise<StaffPage> {
        const where: Prisma.StaffUserWhereInput = {
            ...(filter.role ? { role: filter.role } : {}),
            ...(filter.search
                ? {
                      OR: [
                          { name: { contains: filter.search } },
                          { email: { contains: filter.search } },
                      ],
                  }
                : {}),
            ...(filter.status === 'DEACTIVATED'
                ? { isActive: false }
                : filter.status === 'PENDING'
                  ? { isActive: true, mustChangePassword: true }
                  : filter.status === 'ACTIVE'
                    ? { isActive: true, mustChangePassword: false }
                    : {}),
        };
        const [items, total] = await this.db.$transaction([
            this.db.staffUser.findMany({
                where,
                select: LIST_SELECT,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (filter.page - 1) * filter.pageSize,
                take: filter.pageSize,
            }),
            this.db.staffUser.count({ where }),
        ]);
        return { items, total };
    }

    updateStaff(userId: bigint, changes: StaffChanges): Promise<StaffRecord> {
        return this.db.staffUser.update({
            where: { id: userId },
            data: changes,
            select: RECORD_SELECT,
        });
    }

    /** Switches the account off and ends every session, in one transaction. */
    async deactivateStaff(userId: bigint, now: Date): Promise<StaffRecord> {
        const [, staff] = await this.db.$transaction([
            this.db.authSession.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: now },
            }),
            this.db.staffUser.update({
                where: { id: userId },
                data: { isActive: false },
                select: RECORD_SELECT,
            }),
        ]);
        return staff;
    }

    /** Switches the account back on with a new temporary password: it is pending again. */
    reactivateStaff(
        userId: bigint,
        passwordHash: string,
    ): Promise<StaffRecord> {
        return this.db.staffUser.update({
            where: { id: userId },
            data: {
                isActive: true,
                passwordHash,
                mustChangePassword: true,
                failedLogins: 0,
                lockedUntil: null,
            },
            select: RECORD_SELECT,
        });
    }
}
