import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * lead_assignments, distribution_cursors.
 * Other modules call AssignmentService instead of touching these models.
 */
@Injectable()
export class AssignmentRepository {
    constructor(private readonly db: ModelService) {}
}
