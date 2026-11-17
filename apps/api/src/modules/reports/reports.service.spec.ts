import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IamService } from '@modules/iam';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

describe('ReportsService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                ReportsService,
                { provide: ReportsRepository, useValue: {} },
                { provide: IamService, useValue: {} },
            ],
        }).compile();

        expect(moduleRef.get(ReportsService)).toBeDefined();
    });

    it('refuses a BDA whose account cannot be found, rather than showing the whole team', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                ReportsService,
                { provide: ReportsRepository, useValue: {} },
                { provide: IamService, useValue: { getStaffRef: () => Promise.resolve(null) } },
            ],
        }).compile();

        await expect(
            moduleRef.get(ReportsService).get({ publicId: 'x', role: 'BDA' } as never, { days: 30 }),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });
});
