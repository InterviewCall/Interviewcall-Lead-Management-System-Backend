import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import request from 'supertest';
import { ModelService } from '@app/model';
import { InMemoryRateLimitStore, RATE_LIMIT_STORE } from '@app/rate-limit';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AdminRepository } from '../../src/modules/admin/admin.repository.js';
import { IamRepository } from '../../src/modules/iam/iam.repository.js';
import { NOTIFICATIONS_QUEUE } from '../../src/notifications/notifications.constants.js';
import { InMemoryAdminRepository } from './in-memory-admin.repository.js';
import { InMemoryIamRepository } from './in-memory-iam.repository.js';

export const WEB_ORIGIN = 'http://localhost:3002';

/**
 * The real application with its edges replaced: MySQL by in-memory repositories, and Redis (the
 * email queue and the rate limit counters) by fakes. Everything between them (routing, guard, pipe, filter, services) is real.
 */
export async function createTestApp() {
    process.env.CRM_WEB_ORIGIN = WEB_ORIGIN;

    const repository = new InMemoryIamRepository();
    const admin = new InMemoryAdminRepository();
    const rateLimits = new InMemoryRateLimitStore();
    const queue = {
        /** Resolves when Redis is reachable. Tests swap in a never-resolving promise to simulate an outage. */
        ready: Promise.resolve() as Promise<void>,
        waitUntilReady() {
            return this.ready;
        },
        add: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ModelService)
        .useValue({ $queryRaw: async () => [{ 1: 1 }] })
        .overrideProvider(IamRepository)
        .useValue(repository)
        .overrideProvider(AdminRepository)
        .useValue(admin)
        .overrideProvider(RATE_LIMIT_STORE)
        .useValue(rateLimits)
        .overrideProvider(getQueueToken(NOTIFICATIONS_QUEUE))
        .useValue(queue)
        .compile();

    const app: INestApplication = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    return { app, repository, queue, admin };
}

/** A password hash that is cheap to compute, so tests stay fast. */
export function cheapHash(password: string): Promise<string> {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 1024,
        timeCost: 2,
        parallelism: 1,
    });
}

export function cookieValue(
    setCookie: string | string[] | undefined,
    name: string,
): string | undefined {
    const list = Array.isArray(setCookie)
        ? setCookie
        : setCookie
          ? [setCookie]
          : [];
    const line = list.find((cookie) => cookie.startsWith(`${name}=`));
    return line?.slice(name.length + 1).split(';')[0];
}

/** Signs in through the real endpoint. The agent keeps the cookies for later requests. */
export async function signIn(
    app: INestApplication,
    email: string,
    password: string,
) {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
        .post('/api/v1/auth/login')
        .send({ email, password });
    return {
        agent,
        response,
        /** The value to send as X-CSRF-Token. Changes whenever new cookies are issued. */
        csrf: cookieValue(response.headers['set-cookie'], 'crm_csrf') ?? '',
    };
}
