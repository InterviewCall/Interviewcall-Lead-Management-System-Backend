import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import type { NewSession, StaffAccount } from './iam.types.js';

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
            select: {
                id: true,
                publicId: true,
                name: true,
                email: true,
                passwordHash: true,
                role: true,
                isActive: true,
                mustChangePassword: true,
                lockedUntil: true,
            },
        });
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
}
