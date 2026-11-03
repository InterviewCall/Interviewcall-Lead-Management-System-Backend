import {
    InMemoryRateLimitStore,
    RedisRateLimitStore,
    type RedisLike,
    type RedisPipeline,
} from './rate-limit.store.js';

describe('InMemoryRateLimitStore', () => {
    it('counts within a window and starts again after it', async () => {
        let now = 1_000;
        const store = new InMemoryRateLimitStore(() => now);

        expect(await store.hit('k', 60_000)).toEqual({
            count: 1,
            retryAfterMs: 60_000,
        });
        now += 20_000;
        expect(await store.hit('k', 60_000)).toEqual({
            count: 2,
            retryAfterMs: 40_000,
        });
        now += 40_000;
        expect(await store.hit('k', 60_000)).toEqual({
            count: 1,
            retryAfterMs: 60_000,
        });
    });

    it('keeps keys apart', async () => {
        const store = new InMemoryRateLimitStore(() => 0);

        await store.hit('a', 1000);
        await store.hit('a', 1000);

        expect((await store.hit('b', 1000)).count).toBe(1);
    });
});

describe('RedisRateLimitStore', () => {
    /** A minimal stand-in for the part of ioredis the store calls. */
    function fakeRedis(
        results: Array<[Error | null, unknown]> | null,
    ): RedisLike & { pexpire: ReturnType<typeof vi.fn>; keys: string[] } {
        const keys: string[] = [];
        const pipeline: RedisPipeline = {
            incr(key) {
                keys.push(`incr:${key}`);
                return pipeline;
            },
            pttl(key) {
                keys.push(`pttl:${key}`);
                return pipeline;
            },
            exec: async () => results,
        };
        return {
            multi: () => pipeline,
            pexpire: vi.fn().mockResolvedValue(1),
            keys,
        };
    }

    it('increments and reads the time to live in one transaction', async () => {
        const redis = fakeRedis([
            [null, 3],
            [null, 42_000],
        ]);
        const store = new RedisRateLimitStore(redis);

        await expect(store.hit('rl:x', 60_000)).resolves.toEqual({
            count: 3,
            retryAfterMs: 42_000,
        });
        expect(redis.keys).toEqual(['incr:rl:x', 'pttl:rl:x']);
        expect(redis.pexpire).not.toHaveBeenCalled();
    });

    it('starts the window on the first hit', async () => {
        const redis = fakeRedis([
            [null, 1],
            [null, -1],
        ]);
        const store = new RedisRateLimitStore(redis);

        await expect(store.hit('rl:x', 60_000)).resolves.toEqual({
            count: 1,
            retryAfterMs: 60_000,
        });
        expect(redis.pexpire).toHaveBeenCalledWith('rl:x', 60_000);
    });

    it('repairs a key that lost its expiry instead of blocking it forever', async () => {
        const redis = fakeRedis([
            [null, 500],
            [null, -1],
        ]);
        const store = new RedisRateLimitStore(redis);

        await store.hit('rl:x', 60_000);

        expect(redis.pexpire).toHaveBeenCalledWith('rl:x', 60_000);
    });

    it('throws when Redis reports an error or discards the transaction', async () => {
        await expect(
            new RedisRateLimitStore(
                fakeRedis([
                    [new Error('READONLY'), null],
                    [null, 1],
                ]),
            ).hit('k', 1000),
        ).rejects.toThrow('READONLY');
        await expect(
            new RedisRateLimitStore(fakeRedis(null)).hit('k', 1000),
        ).rejects.toThrow('discarded');
    });
});
