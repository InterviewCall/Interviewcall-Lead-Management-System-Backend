import { SetMetadata } from '@nestjs/common';
import { RATE_LIMIT_KEY } from './rate-limit.constants.js';

export interface RateLimitRule {
    /** Requests allowed per window. */
    limit: number;
    windowSeconds: number;
}

/**
 * Limits one route (or every route of a controller). The count is kept per signed-in user, or
 * per IP address on routes that need no session, and separately for each route. Over the limit
 * the answer is 429 RATE_LIMITED with a Retry-After header.
 */
export const RateLimit = (rule: RateLimitRule) => {
    if (
        !Number.isInteger(rule.limit) ||
        rule.limit < 1 ||
        !Number.isInteger(rule.windowSeconds) ||
        rule.windowSeconds < 1
    ) {
        throw new Error(
            'RateLimit needs a whole-number limit and windowSeconds of at least 1',
        );
    }
    return SetMetadata(RATE_LIMIT_KEY, rule);
};
