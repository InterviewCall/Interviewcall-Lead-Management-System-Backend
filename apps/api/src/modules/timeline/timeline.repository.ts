import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * lead_events.
 * Other modules call TimelineService instead of touching these models.
 */
@Injectable()
export class TimelineRepository {
    constructor(private readonly db: ModelService) {}
}
