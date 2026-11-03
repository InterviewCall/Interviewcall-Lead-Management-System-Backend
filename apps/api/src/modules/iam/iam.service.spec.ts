import { Test } from '@nestjs/testing';
import { IamRepository } from './iam.repository.js';
import { IamService } from './iam.service.js';

describe('IamService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [IamService, { provide: IamRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(IamService)).toBeDefined();
    });
});
