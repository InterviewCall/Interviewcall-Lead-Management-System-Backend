import type { Role } from '@app/prisma';

export type { Role };

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
