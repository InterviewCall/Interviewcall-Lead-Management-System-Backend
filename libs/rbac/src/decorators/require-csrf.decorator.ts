import { SetMetadata } from '@nestjs/common';

export const REQUIRE_CSRF_KEY = 'crm:require-csrf';

/**
 * Makes a @Public() route check the CSRF header like a signed-in route does. For routes that
 * act on a cookie but cannot require a valid access token, such as refresh and logout (the
 * access token has usually expired by then).
 */
export const RequireCsrf = () => SetMetadata(REQUIRE_CSRF_KEY, true);
