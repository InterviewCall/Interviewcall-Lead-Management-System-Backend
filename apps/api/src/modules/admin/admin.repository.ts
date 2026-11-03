import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * audit_log, app_settings.
 * Other modules call AdminService instead of touching these models.
 */
@Injectable()
export class AdminRepository {
    constructor(private readonly db: ModelService) {}

    async ping(): Promise<void> {
        await this.db.$queryRaw`SELECT 1`;
    }
}
