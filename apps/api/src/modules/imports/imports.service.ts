import { Injectable } from '@nestjs/common';
import { ImportsRepository } from './imports.repository.js';

@Injectable()
export class ImportsService {
    constructor(private readonly repository: ImportsRepository) {}
}
