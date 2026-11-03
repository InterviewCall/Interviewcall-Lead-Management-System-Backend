import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

export interface RateLimitHit {
    /** Requests counted in the current window, including this one. */
    count: number;
    /** Milliseconds until the window ends and the count starts again. */
    retryAfterMs: number;
}

/** Counts requests per key in a fixed window. */
export interface RateLimitStore {
    hit(key: string, windowMs: number): Promise<RateLimitHit>;
    close?(): Promise<void>;
}

/** The slice of an ioredis client the store uses, so tests need no Redis. */
export interface RedisLike {
    multi(): RedisPipeline;
    pexpire(key: string, milliseconds: number): Promise<unknown>;
    on?(event: 'error', listener: (error: Error) => void): unknown;
    quit?(): Promise<unknown>;
}

export interface RedisPipeline {
    incr(key: string): RedisPipeline;
    pttl(key: string): RedisPipeline;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/**
 * Fixed-window counters in Redis: INCR the key and read its time to live in one transaction.
 * The first hit of a window has no expiry yet, so it is set then. A key that somehow lost its
 * expiry (a crash between the two steps) gets one on the next hit, so nobody stays blocked.
 */
export class RedisRateLimitStore implements RateLimitStore {
    constructor(private readonly redis: RedisLike) {}

    /**
     * Connects with settings that favour failing fast: with Redis down, a request is let through
     * after a short wait, because login must not depend on the rate limiter being up.
     */
    static connect(url: string): RedisRateLimitStore {
        const logger = new Logger('RateLimit');
        const redis = new Redis(url, {
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            commandTimeout: 1000,
        });
        let lastLogged = 0;
        redis.on('error', (error) => {
            if (Date.now() - lastLogged > 30_000) {
                lastLogged = Date.now();
                logger.warn(
                    `Redis unavailable, requests are not rate limited: ${error.message}`,
                );
            }
        });
        return new RedisRateLimitStore(redis as unknown as RedisLike);
    }

    async hit(key: string, windowMs: number): Promise<RateLimitHit> {
        const results = await this.redis.multi().incr(key).pttl(key).exec();
        if (!results || results.length !== 2) {
            throw new Error('Redis discarded the rate limit transaction');
        }
        const [[incrError, count], [ttlError, ttl]] = results;
        if (incrError) throw incrError;
        if (ttlError) throw ttlError;

        let retryAfterMs = Number(ttl);
        if (!(retryAfterMs > 0)) {
            await this.redis.pexpire(key, windowMs);
            retryAfterMs = windowMs;
        }
        return { count: Number(count), retryAfterMs };
    }

    async close(): Promise<void> {
        await this.redis.quit?.();
    }
}

/** A counter store for tests and single-process use. Not shared between processes. */
export class InMemoryRateLimitStore implements RateLimitStore {
    private readonly windows = new Map<
        string,
        { count: number; resetsAt: number }
    >();

    constructor(private readonly now: () => number = Date.now) {}

    async hit(key: string, windowMs: number): Promise<RateLimitHit> {
        const now = this.now();
        let window = this.windows.get(key);
        if (!window || window.resetsAt <= now) {
            window = { count: 0, resetsAt: now + windowMs };
            this.windows.set(key, window);
        }
        window.count += 1;
        return { count: window.count, retryAfterMs: window.resetsAt - now };
    }
}
