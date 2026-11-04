import type { Role } from '@app/rbac';

export { Role } from '@app/rbac';

/** What login needs to know about a staff user. Never leaves the module as it is. */
export interface StaffAccount {
    /** Numeric key: internal only. Responses and tokens carry publicId. */
    id: bigint;
    publicId: string;
    name: string;
    email: string;
    passwordHash: string;
    role: Role;
    isActive: boolean;
    mustChangePassword: boolean;
    lockedUntil: Date | null;
}

/** A staff user without the password hash. */
export type StaffRecord = Omit<StaffAccount, 'passwordHash' | 'lockedUntil'>;

export interface NewStaff {
    name: string;
    email: string;
    role: Role;
    passwordHash: string;
}

/** A refresh-token session row to create. Only the hash of the token is stored. */
export interface NewSession {
    tokenHash: string;
    familyId: string;
    userAgent: string | null;
    ip: string | null;
    expiresAt: Date;
}

/** The signed-in user as the web app sees it. */
export interface SessionUser {
    id: string;
    name: string;
    email: string;
    role: Role;
    mustChangePassword: boolean;
}

/**
 * Where a staff account stands. PENDING means the temporary password has not been replaced yet;
 * the account becomes ACTIVE when its owner chooses their own password. DEACTIVATED is the admin's
 * on/off switch and wins over the other two.
 */
export type StaffStatus = 'PENDING' | 'ACTIVE' | 'DEACTIVATED';

export interface StaffView {
    id: string;
    name: string;
    email: string;
    role: Role;
    status: StaffStatus;
}

/** Where a request came from: kept on sessions and in the audit log. */
export interface RequestMeta {
    ip: string | undefined;
    userAgent: string | undefined;
}

/** A refresh-token session row as read back. */
export interface SessionRow {
    id: bigint;
    userId: bigint;
    familyId: string;
    expiresAt: Date;
    revokedAt: Date | null;
}

/** A session found by its token, with the account it belongs to. */
export interface SessionLookup {
    session: SessionRow;
    account: StaffAccount;
}

/** A row of the staff list. */
export interface StaffListRecord extends StaffRecord {
    createdAt: Date;
    lastLoginAt: Date | null;
}

export interface StaffListFilter {
    search?: string;
    role?: Role;
    status?: StaffStatus;
    page: number;
    pageSize: number;
}

export interface StaffPage {
    items: StaffListRecord[];
    total: number;
}

/** What an admin may change on an existing account. */
export interface StaffChanges {
    name?: string;
    role?: Role;
}

export interface StaffListItem extends StaffView {
    createdAt: string;
    lastLoginAt: string | null;
}

/** A staff user as other modules see them: enough to name them and to link a row to them. */
export interface StaffRef {
    /** Numeric key: for foreign keys inside the API only. Never put it in a response. */
    id: bigint;
    publicId: string;
    name: string;
    role: Role;
    isActive: boolean;
}
