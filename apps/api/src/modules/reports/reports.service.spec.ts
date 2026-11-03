import { Test } from '@nestjs/testing';
import { ReportsService } from './reports.service.js';

describe('ReportsService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [ReportsService],
        }).compile();

        expect(moduleRef.get(ReportsService)).toBeDefined();
    });
});
