import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type SuppressionCheckBody, suppressionCheckSchema } from '@modules/leads';
import { type EventBatch, eventBatchSchema, type EventEnvelope, eventEnvelopeSchema } from './intake.schemas.js';
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

    /**
     * Up to 100 events in one call, for a sender catching up after a pause. Each row is judged on its own and the
     * answer lists what happened to every one, so the sender knows exactly which to resend. Sending a row again is safe.
     */
    @Post('events/batch')
    @HttpCode(200)
    @RateLimit({ limit: 60, windowSeconds: 60 })
    receiveBatch(@Req() request: SourceRequest, @Body({ schema: eventBatchSchema }) body: EventBatch) {
        return this.intake.receiveBatch(request.source!.system, body.events);
    }

    /** Which phones and emails belong to a lead marked do-not-contact. The messaging gateway asks before every send. */
    @Post('suppression/check')
    @HttpCode(200)
    @RateLimit({ limit: 120, windowSeconds: 60 })
    checkSuppression(@Body({ schema: suppressionCheckSchema }) body: SuppressionCheckBody) {
        return this.intake.checkSuppression(body.phones, body.emails);
    }
}
