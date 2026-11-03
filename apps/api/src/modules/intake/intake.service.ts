import { Injectable } from '@nestjs/common';
import { IntakeRepository } from './intake.repository.js';

@Injectable()
export class IntakeService {
    constructor(private readonly repository: IntakeRepository) {}
}
