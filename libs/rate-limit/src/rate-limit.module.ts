import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RATE_LIMIT_STORE } from './rate-limit.constants.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import {
    type RateLimitStore,
    RedisRateLimitStore,
} from './rate-limit.store.js';

/**
 * Import once in an API's root module. Routes marked @RateLimit(...) are then limited, with the
 * counters kept in the Redis at REDIS_URL so every instance of the API shares them.
 */
@Module({
    providers: [
        {
            provide: RATE_LIMIT_STORE,
            useFactory: (): RateLimitStore => {
                const url = process.env.REDIS_URL;
                if (!url) {
                    throw new Error(
                        'Missing required environment variable: REDIS_URL',
                    );
                }
                return RedisRateLimitStore.connect(url);
            },
        },
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    ],
})
export class RateLimitModule implements OnApplicationShutdown {
    constructor(
        @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    ) {}

    async onApplicationShutdown(): Promise<void> {
        await this.store.close?.();
    }
}
