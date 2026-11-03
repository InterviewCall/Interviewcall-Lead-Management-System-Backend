import { Test } from '@nestjs/testing';
import { PipelineRepository } from './pipeline.repository.js';
import { PipelineService } from './pipeline.service.js';

describe('PipelineService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                PipelineService,
                { provide: PipelineRepository, useValue: {} },
            ],
        }).compile();

        expect(moduleRef.get(PipelineService)).toBeDefined();
    });
});
