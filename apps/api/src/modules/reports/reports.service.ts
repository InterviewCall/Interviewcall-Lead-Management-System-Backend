import { Injectable } from '@nestjs/common';

/**
 * Reports owns no tables. Its queries run through a read-only MySQL user,
 * so they can never write to another module's data.
 */
@Injectable()
export class ReportsService {}
