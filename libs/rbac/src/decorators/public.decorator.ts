import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'crm:public';

/**
 * Skips the staff session check. Every route needs a session unless it says otherwise:
 * login, health and the API-key intake routes are the exceptions.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
