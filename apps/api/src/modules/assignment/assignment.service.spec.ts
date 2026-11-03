import { Test } from '@nestjs/testing';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';

describe('AssignmentService', () => {
    it('should be defined', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [AssignmentService, { provide: AssignmentRepository, useValue: {} }],
        }).compile();

        expect(moduleRef.get(AssignmentService)).toBeDefined();
    });
});
