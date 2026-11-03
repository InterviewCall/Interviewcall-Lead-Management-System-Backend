import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './support/create-test-app.js';

describe('crm-api (e2e)', () => {
    let app: INestApplication;

    beforeAll(async () => {
        ({ app } = await createTestApp());
    });

    afterAll(async () => {
        await app.close();
    });

    it('/health (GET) needs no session', () => {
        return request(app.getHttpServer())
            .get('/health')
            .expect(200)
            .expect({ status: 'ok' });
    });

    it('/api/v1/health does not exist: the deploy check lives outside the prefix', () => {
        return request(app.getHttpServer()).get('/api/v1/health').expect(404);
    });
});
