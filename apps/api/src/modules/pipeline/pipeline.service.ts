import { Injectable } from '@nestjs/common';
import { PipelineRepository } from './pipeline.repository.js';

@Injectable()
export class PipelineService {
    constructor(private readonly repository: PipelineRepository) {}
}
