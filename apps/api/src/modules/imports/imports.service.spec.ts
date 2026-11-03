import { Test } from '@nestjs/testing';
import { ImportsRepository } from './imports.repository.js';
import { ImportsService } from './imports.service.js';

describe('ImportsService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [ImportsService, { provide: ImportsRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(ImportsService)).toBeDefined();
    });
});
