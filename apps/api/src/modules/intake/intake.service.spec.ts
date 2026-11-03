import { Test } from '@nestjs/testing';
import { IntakeRepository } from './intake.repository.js';
import { IntakeService } from './intake.service.js';

describe('IntakeService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [IntakeService, { provide: IntakeRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(IntakeService)).toBeDefined();
    });
});
