import { Injectable } from '@nestjs/common';
import { LeadsRepository } from './leads.repository.js';

@Injectable()
export class LeadsService {
    constructor(private readonly repository: LeadsRepository) {}
}
