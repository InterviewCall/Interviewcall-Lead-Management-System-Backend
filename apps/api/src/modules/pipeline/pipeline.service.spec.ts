import { Test } from '@nestjs/testing';
import { IamService } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { TimelineService } from '@modules/timeline';
import { PipelineRepository } from './pipeline.repository.js';
import { PipelineService } from './pipeline.service.js';

describe('PipelineService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                PipelineService,
                { provide: PipelineRepository, useValue: {} },
                { provide: LeadsService, useValue: {} },
                { provide: TimelineService, useValue: {} },
                { provide: IamService, useValue: {} },
            ],
        }).compile();

        expect(moduleRef.get(PipelineService)).toBeDefined();
    });
});
