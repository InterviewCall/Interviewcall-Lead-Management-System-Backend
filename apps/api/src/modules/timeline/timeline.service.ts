import { Injectable } from '@nestjs/common';
import { TimelineRepository } from './timeline.repository.js';

@Injectable()
export class TimelineService {
    constructor(private readonly repository: TimelineRepository) {}
}
