import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ModelService } from '@app/model';
import { IMPORTS_QUEUE } from './modules/imports/imports.constants.js';
import { INTAKE_QUEUE } from './modules/intake/intake.constants.js';
import { NOTIFICATIONS_QUEUE } from './notifications/notifications.constants.js';
import { WorkerModule } from './worker.module.js';

describe('WorkerModule', () => {
    it('wires every module without an HTTP server', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [WorkerModule],
        })
            .overrideProvider(ModelService)
            .useValue({})
            // No Redis in unit tests: the queue is replaced, everything else is the real wiring.
            .overrideProvider(getQueueToken(NOTIFICATIONS_QUEUE))
            .useValue({ close: async () => undefined })
            .overrideProvider(getQueueToken(IMPORTS_QUEUE))
            .useValue({ close: async () => undefined })
            .overrideProvider(getQueueToken(INTAKE_QUEUE))
            .useValue({ close: async () => undefined })
            .compile();

        expect(moduleRef).toBeDefined();
        await moduleRef.close();
    });
});
