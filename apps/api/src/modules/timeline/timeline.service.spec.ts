import { Test } from '@nestjs/testing';
import { TimelineRepository } from './timeline.repository.js';
import { TimelineService } from './timeline.service.js';

describe('TimelineService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [TimelineService, { provide: TimelineRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(TimelineService)).toBeDefined();
    });
});
