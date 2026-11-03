/**
 * Every role a staff account can have. The database enum (staff_users.role) must list the same
 * values: iam has a test that fails if the two drift apart.
 */
export const Role = {
    BDA: 'BDA',
    SALES_MANAGER: 'SALES_MANAGER',
    CLOSER: 'CLOSER',
    OPS: 'OPS',
    ADMIN: 'ADMIN',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ROLES: readonly Role[] = Object.values(Role);
