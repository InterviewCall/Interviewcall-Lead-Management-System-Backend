import { Test } from '@nestjs/testing';
import { AdminRepository } from './admin.repository.js';
import { AdminService } from './admin.service.js';

describe('AdminService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [AdminService, { provide: AdminRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(AdminService)).toBeDefined();
    });
});
