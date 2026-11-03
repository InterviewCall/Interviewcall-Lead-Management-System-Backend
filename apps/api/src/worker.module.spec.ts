import { Test } from '@nestjs/testing';
import { ModelService } from '@app/model';
import { WorkerModule } from './worker.module.js';

describe('WorkerModule', () => {
    it('wires every module without an HTTP server', async () => {
        const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
            .overrideProvider(ModelService)
            .useValue({})
            .compile();

        expect(moduleRef).toBeDefined();
        await moduleRef.close();
    });
});
