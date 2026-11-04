import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { leadIdSchema } from '@modules/leads';
import {
    type MarkLostBody,
    markLostSchema,
    type MoveStageBody,
    moveStageSchema,
} from './pipeline.schemas.js';
import { PipelineService } from './pipeline.service.js';

const MARKS = { limit: 60, windowSeconds: 60 } as const;

/**
 * Marking a lead's opportunity: move it between stages, close it as won or lost, reopen it.
 * What a person may touch follows what they may see (a BDA their own leads, a closer the leads
 * in play). Each call returns the refreshed lead, like GET /leads/:id.
 */
@Controller()
export class PipelineController {
    constructor(private readonly pipeline: PipelineService) {}

    /** The reasons offered when marking a lead lost. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('pipeline/lost-reasons')
    lostReasons() {
        return this.pipeline.listLostReasons();
    }

    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/:id/opportunity/stage')
    @HttpCode(200)
    @RateLimit(MARKS)
    moveStage(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: moveStageSchema }) body: MoveStageBody,
    ) {
        return this.pipeline.moveStage(auth, id, body.stage);
    }

    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/:id/opportunity/lost')
    @HttpCode(200)
    @RateLimit(MARKS)
    markLost(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: markLostSchema }) body: MarkLostBody,
    ) {
        return this.pipeline.markLost(auth, id, body.reasonId, body.note);
    }

    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/:id/opportunity/reopen')
    @HttpCode(200)
    @RateLimit(MARKS)
    reopen(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
    ) {
        return this.pipeline.reopen(auth, id);
    }
}
