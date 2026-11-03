import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * leads, lead_identities, lead_sources, touchpoints, form_responses, bookings, custom_field_definitions, saved_views.
 * Other modules call LeadsService instead of touching these models.
 */
@Injectable()
export class LeadsRepository {
    constructor(private readonly db: ModelService) {}
}
