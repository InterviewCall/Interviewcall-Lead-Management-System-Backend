import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import {
    eventIdSchema,
    type ListEventsQuery,
    listEventsQuerySchema,
} from './intake.schemas.js';
import { IntakeService } from './intake.service.js';
import type { EventView, IntakeSummary } from './intake.types.js';

/** The Intake monitor: what the sender services have sent and what became of it. */
@Roles('ADMIN', 'OPS')
@Controller('intake')
export class IntakeAdminController {
    constructor(private readonly intake: IntakeService) {}

    @Get('summary')
    summary(): Promise<IntakeSummary> {
        return this.intake.summary();
    }

    @Get('events')
    async events(
        @Query({ schema: listEventsQuerySchema }) query: ListEventsQuery,
    ): Promise<{ events: EventView[] }> {
        return { events: await this.intake.listEvents(query.status, query.limit) };
    }

    @Post('events/:id/retry')
    @HttpCode(200)
    @RateLimit({ limit: 60, windowSeconds: 60 })
    retry(@Param('id', { schema: eventIdSchema }) id: bigint): Promise<{ ok: true }> {
        return this.intake.retry(id);
    }
}
