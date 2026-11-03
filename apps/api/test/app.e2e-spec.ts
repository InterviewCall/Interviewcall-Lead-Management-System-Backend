import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ModelService } from '@app/model';
import { AppModule } from './../src/app.module.js';

describe('crm-api (e2e)', () => {
    let app: INestApplication;

    beforeEach(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        })
            // No real database in e2e: the health check only needs a query that resolves.
            .overrideProvider(ModelService)
            .useValue({ $queryRaw: async () => [{ 1: 1 }] })
            .compile();

        app = moduleFixture.createNestApplication();
        await app.init();
    });

    it('/health (GET)', () => {
        return request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
    });

    afterEach(async () => {
        await app.close();
    });
});
