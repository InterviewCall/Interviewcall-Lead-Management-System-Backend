import { Test } from '@nestjs/testing';
import { LeadsRepository } from './leads.repository.js';
import { LeadsService } from './leads.service.js';

describe('LeadsService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [LeadsService, { provide: LeadsRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(LeadsService)).toBeDefined();
    });
});
