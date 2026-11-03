import { ServiceUnavailableException } from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { HealthController } from './health.controller.js';

function controllerWith(checkDatabase: () => Promise<void>): HealthController {
    return new HealthController({ checkDatabase } as unknown as AdminService);
}

describe('HealthController', () => {
    it('returns ok when the database answers', async () => {
        const controller = controllerWith(async () => undefined);
        await expect(controller.check()).resolves.toEqual({ status: 'ok' });
    });

    it('returns 503 when the database does not answer', async () => {
        const controller = controllerWith(async () => {
            throw new Error('connect ECONNREFUSED');
        });
        await expect(controller.check()).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });
});
