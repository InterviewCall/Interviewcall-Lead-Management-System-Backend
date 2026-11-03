import { Injectable } from '@nestjs/common';
import { EngagementRepository } from './engagement.repository.js';

@Injectable()
export class EngagementService {
    constructor(private readonly repository: EngagementRepository) {}
}
