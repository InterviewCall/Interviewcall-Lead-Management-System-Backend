import { Controller, Get, type INestApplication, Logger } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RATE_LIMIT_STORE } from './rate-limit.constants.js';
import { RateLimit } from './rate-limit.decorator.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import {
    InMemoryRateLimitStore,
    type RateLimitStore,
} from './rate-limit.store.js';

@Controller('probe')
class ProbeController {
    @Get('limited')
    @RateLimit({ limit: 2, windowSeconds: 60 })
    limited() {
        return { ok: true };
    }

    @Get('other')
    @RateLimit({ limit: 2, windowSeconds: 60 })
    other() {
        return { ok: true };
    }

    @Get('free')
    free() {
        return { ok: true };
    }
}

describe('RateLimitInterceptor', () => {
    let app: INestApplication;

    async function start(store: RateLimitStore, currentUser?: string) {
        const moduleRef = await Test.createTestingModule({
            controllers: [ProbeController],
            providers: [
                { provide: RATE_LIMIT_STORE, useValue: store },
                { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        if (currentUser) {
            // Stands in for the session guard, which sets request.auth.
            app.use((req: any, _res: unknown, next: () => void) => {
                req.auth = { publicId: req.headers['x-user'] ?? currentUser };
                next();
            });
        }
        await app.init();
        return app.getHttpServer();
    }

    afterEach(async () => {
        await app?.close();
    });

    it('lets requests through up to the limit, then answers 429 with Retry-After', async () => {
        const server = await start(new InMemoryRateLimitStore());

        await request(server).get('/probe/limited').expect(200);
        await request(server).get('/probe/limited').expect(200);
        const blocked = await request(server).get('/probe/limited').expect(429);

        expect(blocked.body).toEqual({
            code: 'RATE_LIMITED',
            message: expect.stringMatching(
                /^Too many requests\. Try again in \d+ seconds?\.$/,
            ),
        });
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('counts each route on its own and ignores routes without a rule', async () => {
        const server = await start(new InMemoryRateLimitStore());

        await request(server).get('/probe/limited').expect(200);
        await request(server).get('/probe/limited').expect(200);
        await request(server).get('/probe/other').expect(200);
        for (let i = 0; i < 5; i++) {
            await request(server).get('/probe/free').expect(200);
        }
    });

    it('counts per signed-in user when there is one, so two users do not share a limit', async () => {
        const server = await start(new InMemoryRateLimitStore(), 'user-a');

        await request(server)
            .get('/probe/limited')
            .set('x-user', 'a')
            .expect(200);
        await request(server)
            .get('/probe/limited')
            .set('x-user', 'a')
            .expect(200);
        await request(server)
            .get('/probe/limited')
            .set('x-user', 'a')
            .expect(429);
        await request(server)
            .get('/probe/limited')
            .set('x-user', 'b')
            .expect(200);
    });

    it('lets the request through, and logs, when the store fails', async () => {
        const error = vi
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);
        const server = await start({
            hit: async () => {
                throw new Error('Redis is down');
            },
        });

        await request(server).get('/probe/limited').expect(200);
        await request(server).get('/probe/limited').expect(200);
        await request(server).get('/probe/limited').expect(200);

        expect(String(error.mock.calls[0][0])).toContain('Redis is down');
        error.mockRestore();
    });
});

describe('RateLimit decorator', () => {
    it('rejects a rule that cannot work', () => {
        expect(() => RateLimit({ limit: 0, windowSeconds: 60 })).toThrow();
        expect(() => RateLimit({ limit: 5, windowSeconds: 0 })).toThrow();
        expect(() => RateLimit({ limit: 1.5, windowSeconds: 60 })).toThrow();
    });
});
