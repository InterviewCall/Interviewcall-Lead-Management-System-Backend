import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type EventEnvelope, eventEnvelopeSchema } from './intake.schemas.js';
import { IntakeService } from './intake.service.js';
import { SourceKeyGuard, type SourceRequest } from './source-key.guard.js';

/** Plenty for WorkR's busiest hour; stops a runaway sender from filling the inbox. */
const EVENTS_LIMIT = { limit: 600, windowSeconds: 60 } as const;

/** Where the sender services post their events. They sign in with a key, not a staff session. */
@Public()
@UseGuards(SourceKeyGuard)
@Controller('intake')
export class IntakeController {
    constructor(private readonly intake: IntakeService) {}

    /**
     * Stores the event and answers 202 at once. Sending the same eventId again is safe and answers
     * with `duplicate: true`.
     */
    @Post('events')
    @HttpCode(202)
    @RateLimit(EVENTS_LIMIT)
    receive(
        @Req() request: SourceRequest,
        @Body({ schema: eventEnvelopeSchema }) body: EventEnvelope,
    ): Promise<{ id: string; duplicate: boolean }> {
        return this.intake.receive(request.source!.system, body);
    }
}
