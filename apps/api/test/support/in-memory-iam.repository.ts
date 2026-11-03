import { randomUUID } from 'node:crypto';
import type {
    NewSession,
    NewStaff,
    SessionLookup,
    StaffAccount,
    StaffChanges,
    StaffListFilter,
    StaffListRecord,
    StaffPage,
    StaffRecord,
} from '../../src/modules/iam/iam.types.js';

export interface StoredSession extends NewSession {
    id: bigint;
    userId: bigint;
    revokedAt: Date | null;
}

/**
 * Stands in for IamRepository in e2e tests, with the same observable behaviour as the real
 * queries but no database. Tests can read `accounts` and `sessions` to check what was stored.
 */
export class InMemoryIamRepository {
    readonly accounts: StaffAccount[] = [];
    readonly sessions: StoredSession[] = [];
    private readonly failures = new Map<bigint, number>();
    private readonly createdAt = new Map<bigint, Date>();
    private readonly lastLoginAt = new Map<bigint, Date>();
    private nextId = 1n;
    private nextSessionId = 1n;

    /** Test helper: puts an account straight into the store. */
    add(
        account: Omit<StaffAccount, 'id' | 'publicId' | 'lockedUntil'> &
            Partial<StaffAccount>,
    ): StaffAccount {
        const stored: StaffAccount = {
            id: this.nextId++,
            publicId: randomUUID(),
            lockedUntil: null,
            ...account,
        };
        this.accounts.push(stored);
        // One second apart, so "newest first" is well defined.
        this.createdAt.set(
            stored.id,
            new Date(Date.UTC(2026, 0, 1) + Number(stored.id) * 1000),
        );
        return stored;
    }

    accountByEmail(email: string): StaffAccount | undefined {
        return this.accounts.find((account) => account.email === email);
    }

    async findStaffByEmail(email: string): Promise<StaffAccount | null> {
        return this.copy(this.accountByEmail(email));
    }

    async findStaffByPublicId(publicId: string): Promise<StaffAccount | null> {
        return this.copy(
            this.accounts.find((account) => account.publicId === publicId),
        );
    }

    async createStaff(staff: NewStaff): Promise<StaffRecord | null> {
        if (this.accountByEmail(staff.email)) {
            return null;
        }
        const {
            passwordHash: _hash,
            lockedUntil: _lock,
            ...record
        } = this.add({
            ...staff,
            isActive: true,
            mustChangePassword: true,
        });
        return record;
    }

    async deleteStaff(userId: bigint): Promise<void> {
        const index = this.accounts.findIndex(
            (account) => account.id === userId,
        );
        if (index >= 0) this.accounts.splice(index, 1);
    }

    async recordFailedLogin(
        userId: bigint,
        rule: { maxAttempts: number; lockUntil: Date },
    ): Promise<boolean> {
        const count = (this.failures.get(userId) ?? 0) + 1;
        if (count < rule.maxAttempts) {
            this.failures.set(userId, count);
            return false;
        }
        this.failures.set(userId, 0);
        this.mutate(userId, { lockedUntil: rule.lockUntil });
        return true;
    }

    async recordSuccessfulLogin(
        userId: bigint,
        session: NewSession,
        now: Date,
    ): Promise<void> {
        this.failures.set(userId, 0);
        this.mutate(userId, { lockedUntil: null });
        this.lastLoginAt.set(userId, now);
        this.pushSession(userId, session);
    }

    async setTemporaryPassword(
        userId: bigint,
        passwordHash: string,
        now: Date,
    ): Promise<void> {
        this.revokeSessions(userId, now);
        this.failures.set(userId, 0);
        this.mutate(userId, {
            passwordHash,
            mustChangePassword: true,
            lockedUntil: null,
        });
    }

    async changePassword(
        userId: bigint,
        passwordHash: string,
        session: NewSession,
        now: Date,
    ): Promise<void> {
        this.revokeSessions(userId, now);
        this.failures.set(userId, 0);
        this.mutate(userId, {
            passwordHash,
            mustChangePassword: false,
            lockedUntil: null,
        });
        this.pushSession(userId, session);
    }

    async findSessionByTokenHash(
        tokenHash: string,
    ): Promise<SessionLookup | null> {
        const session = this.sessions.find(
            (candidate) => candidate.tokenHash === tokenHash,
        );
        const account = session
            ? this.accounts.find((candidate) => candidate.id === session.userId)
            : undefined;
        if (!session || !account) {
            return null;
        }
        return {
            session: {
                id: session.id,
                userId: session.userId,
                familyId: session.familyId,
                expiresAt: session.expiresAt,
                revokedAt: session.revokedAt,
            },
            account: { ...account },
        };
    }

    async rotateSession(
        oldSessionId: bigint,
        userId: bigint,
        next: NewSession,
        now: Date,
    ): Promise<boolean> {
        const old = this.sessions.find(
            (session) => session.id === oldSessionId,
        );
        if (!old || old.revokedAt) {
            return false;
        }
        old.revokedAt = now;
        this.pushSession(userId, next);
        return true;
    }

    async revokeFamily(familyId: string, now: Date): Promise<number> {
        let count = 0;
        for (const session of this.sessions) {
            if (session.familyId === familyId && !session.revokedAt) {
                session.revokedAt = now;
                count += 1;
            }
        }
        return count;
    }

    async familyHasActiveSession(
        familyId: string,
        now: Date,
    ): Promise<boolean> {
        return this.sessions.some(
            (session) =>
                session.familyId === familyId &&
                !session.revokedAt &&
                session.expiresAt > now,
        );
    }

    async listStaff(filter: StaffListFilter): Promise<StaffPage> {
        const search = filter.search?.toLowerCase();
        const matching = this.accounts
            .filter((account) => !filter.role || account.role === filter.role)
            .filter(
                (account) =>
                    !search ||
                    account.name.toLowerCase().includes(search) ||
                    account.email.toLowerCase().includes(search),
            )
            .filter((account) => {
                if (!filter.status) return true;
                if (filter.status === 'DEACTIVATED') return !account.isActive;
                if (!account.isActive) return false;
                return filter.status === 'PENDING'
                    ? account.mustChangePassword
                    : !account.mustChangePassword;
            })
            .sort((a, b) => Number(b.id - a.id));
        const start = (filter.page - 1) * filter.pageSize;
        return {
            items: matching
                .slice(start, start + filter.pageSize)
                .map((account) => this.toListRecord(account)),
            total: matching.length,
        };
    }

    async updateStaff(
        userId: bigint,
        changes: StaffChanges,
    ): Promise<StaffRecord> {
        return this.record(this.mutate(userId, changes));
    }

    async deactivateStaff(userId: bigint, now: Date): Promise<StaffRecord> {
        this.revokeSessions(userId, now);
        return this.record(this.mutate(userId, { isActive: false }));
    }

    async reactivateStaff(
        userId: bigint,
        passwordHash: string,
    ): Promise<StaffRecord> {
        this.failures.set(userId, 0);
        return this.record(
            this.mutate(userId, {
                isActive: true,
                passwordHash,
                mustChangePassword: true,
                lockedUntil: null,
            }),
        );
    }

    activeSessions(userId: bigint): StoredSession[] {
        return this.sessions.filter(
            (session) => session.userId === userId && !session.revokedAt,
        );
    }

    private pushSession(userId: bigint, session: NewSession): void {
        this.sessions.push({
            ...session,
            id: this.nextSessionId++,
            userId,
            revokedAt: null,
        });
    }

    private revokeSessions(userId: bigint, now: Date): void {
        for (const session of this.sessions) {
            if (session.userId === userId && !session.revokedAt)
                session.revokedAt = now;
        }
    }

    private mutate(
        userId: bigint,
        changes: Partial<StaffAccount>,
    ): StaffAccount {
        const account = this.accounts.find(
            (candidate) => candidate.id === userId,
        );
        if (!account) throw new Error(`No account ${userId}`);
        Object.assign(account, changes);
        return account;
    }

    private record(account: StaffAccount): StaffRecord {
        const { passwordHash: _hash, lockedUntil: _lock, ...record } = account;
        return record;
    }

    private toListRecord(account: StaffAccount): StaffListRecord {
        return {
            ...this.record(account),
            createdAt: this.createdAt.get(account.id) ?? new Date(0),
            lastLoginAt: this.lastLoginAt.get(account.id) ?? null,
        };
    }

    private copy(account: StaffAccount | undefined): StaffAccount | null {
        return account ? { ...account } : null;
    }
}
