import { Test } from '@nestjs/testing';
import { RATE_LIMIT_STORE } from './rate-limit.constants.js';
import { RateLimitModule } from './rate-limit.module.js';

describe('RateLimitModule', () => {
    it('closes the store on shutdown', async () => {
        const close = vi.fn().mockResolvedValue(undefined);
        const moduleRef = await Test.createTestingModule({
            imports: [RateLimitModule],
        })
            .overrideProvider(RATE_LIMIT_STORE)
            .useValue({ hit: vi.fn(), close })
            .compile();

        await moduleRef.init();
        await moduleRef.close();

        expect(close).toHaveBeenCalledTimes(1);
    });

    it('refuses to start without REDIS_URL', async () => {
        const saved = process.env.REDIS_URL;
        delete process.env.REDIS_URL;
        try {
            await expect(
                Test.createTestingModule({
                    imports: [RateLimitModule],
                }).compile(),
            ).rejects.toThrow('REDIS_URL');
        } finally {
            if (saved !== undefined) process.env.REDIS_URL = saved;
        }
    });
});
