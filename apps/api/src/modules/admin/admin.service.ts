import { Injectable } from '@nestjs/common';
import { AdminRepository } from './admin.repository.js';

@Injectable()
export class AdminService {
    constructor(private readonly repository: AdminRepository) {}

    /** Resolves when the database answers; rejects otherwise. */
    async checkDatabase(): Promise<void> {
        await this.repository.ping();
    }
}
