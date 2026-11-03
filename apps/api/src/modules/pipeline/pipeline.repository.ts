import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * opportunities, opportunity_stage_changes, lost_reasons.
 * Other modules call PipelineService instead of touching these models.
 */
@Injectable()
export class PipelineRepository {
    constructor(private readonly db: ModelService) {}
}
