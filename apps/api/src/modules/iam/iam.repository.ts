import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * staff_users, auth_sessions, source_credentials.
 * Other modules call IamService instead of touching these models.
 */
@Injectable()
export class IamRepository {
    constructor(private readonly db: ModelService) {}
}
