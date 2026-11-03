import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';

/** Turns redis://user:pass@host:port/db into the connection options BullMQ expects. */
export function redisConnectionFromUrl(url: string) {
    const parsed = new URL(url);
    const db =
        parsed.pathname.length > 1
            ? Number(parsed.pathname.slice(1))
            : undefined;
    return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 6379,
        username: parsed.username
            ? decodeURIComponent(parsed.username)
            : undefined,
        password: parsed.password
            ? decodeURIComponent(parsed.password)
            : undefined,
        db: db !== undefined && Number.isInteger(db) ? db : undefined,
        ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    };
}

/**
 * The one Redis connection setting for every queue. Imported by AppModule and WorkerModule,
 * so a queue only needs `BullModule.registerQueue` in its own module.
 */
export function queueRootModule(): DynamicModule {
    return BullModule.forRootAsync({
        useFactory: () => {
            const url = process.env.REDIS_URL;
            if (!url) {
                throw new Error(
                    'Missing required environment variable: REDIS_URL',
                );
            }
            return { connection: redisConnectionFromUrl(url) };
        },
    });
}
