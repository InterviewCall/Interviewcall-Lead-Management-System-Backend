/** Injection token for the counter store (Redis in production, in memory in tests). */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export const RATE_LIMIT_KEY = 'crm:rate-limit';
