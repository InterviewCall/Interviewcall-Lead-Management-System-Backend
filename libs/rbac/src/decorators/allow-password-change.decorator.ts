import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_KEY = 'crm:allow-password-change';

/**
 * Marks a route that a user with a temporary password may call. Every other route answers
 * 403 PASSWORD_CHANGE_REQUIRED until the password has been changed.
 */
export const AllowPasswordChange = () =>
    SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);
