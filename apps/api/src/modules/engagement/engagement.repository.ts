import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * outcomes, activities, tasks, notifications.
 * Other modules call EngagementService instead of touching these models.
 */
@Injectable()
export class EngagementRepository {
    constructor(private readonly db: ModelService) {}
}
