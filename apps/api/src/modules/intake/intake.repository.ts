import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * inbox_events, reconciliation_cursors.
 * Other modules call IntakeService instead of touching these models.
 */
@Injectable()
export class IntakeRepository {
    constructor(private readonly db: ModelService) {}
}
