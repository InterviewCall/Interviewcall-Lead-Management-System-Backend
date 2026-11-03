/** The cookies that carry a staff session. The access and CSRF names are shared by every API. */
export const ACCESS_COOKIE = 'crm_access';
export const CSRF_COOKIE = 'crm_csrf';

/** Sent on every write; must equal the CSRF cookie. */
export const CSRF_HEADER = 'x-csrf-token';
