import { Injectable } from '@nestjs/common';
import { AssignmentRepository } from './assignment.repository.js';

@Injectable()
export class AssignmentService {
    constructor(private readonly repository: AssignmentRepository) {}
}
