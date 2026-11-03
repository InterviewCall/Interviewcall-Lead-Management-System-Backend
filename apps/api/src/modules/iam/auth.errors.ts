import { UnauthorizedException } from '@nestjs/common';
import type { SessionUser, StaffAccount } from './iam.types.js';

export function unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue',
    });
}

/** The account as the web app sees it. `mustChangePassword` defaults to the stored value. */
export function toSessionUser(
    account: StaffAccount,
    mustChangePassword: boolean = account.mustChangePassword,
): SessionUser {
    return {
        id: account.publicId,
        name: account.name,
        email: account.email,
        role: account.role,
        mustChangePassword,
    };
}
