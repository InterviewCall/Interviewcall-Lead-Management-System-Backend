import { Test } from '@nestjs/testing';
import { EngagementRepository } from './engagement.repository.js';
import { EngagementService } from './engagement.service.js';

describe('EngagementService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [EngagementService, { provide: EngagementRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(EngagementService)).toBeDefined();
    });
});
