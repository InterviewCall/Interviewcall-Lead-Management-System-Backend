import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';

/**
 * The only class allowed to read or write this module's tables:
 * import_jobs, import_rows.
 * Other modules call ImportsService instead of touching these models.
 */
@Injectable()
export class ImportsRepository {
    constructor(private readonly db: ModelService) {}
}
