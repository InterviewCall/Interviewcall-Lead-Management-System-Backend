import { Body, Controller, Get, HttpCode, Ip, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { leadIdSchema } from '@modules/leads';
import {
    type BoardQuery,
    boardQuerySchema,
    type CreateLostReasonBody,
    createLostReasonSchema,
    lostReasonIdSchema,
    type UpdateLostReasonBody,
    updateLostReasonSchema,
    type EnrolmentBody,
    enrolmentSchema,
    type MarkLostBody,
    markLostSchema,
    type MarkWonBody,
    markWonSchema,
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

    /** The board: open opportunities by stage, as far as this person may see them. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('pipeline')
    board(@CurrentUser() auth: AuthContext, @Query({ schema: boardQuerySchema }) query: BoardQuery) {
        return this.pipeline.board(auth, query);
    }

    /** The reasons offered when marking a lead lost. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('pipeline/lost-reasons')
    lostReasons() {
        return this.pipeline.listLostReasons();
    }

    /** Every lost reason, retired ones too, with how often each was used. For the settings editor. */
    @Roles('ADMIN', 'SALES_MANAGER')
    @Get('pipeline/lost-reasons/all')
    allLostReasons() {
        return this.pipeline.listLostReasonsForAdmin();
    }

    @Roles('ADMIN', 'SALES_MANAGER')
    @Post('pipeline/lost-reasons')
    @HttpCode(200)
    @RateLimit({ limit: 30, windowSeconds: 60 })
    createLostReason(@CurrentUser() auth: AuthContext, @Body({ schema: createLostReasonSchema }) body: CreateLostReasonBody, @Ip() ip: string) {
        return this.pipeline.createLostReason(auth, body, ip);
    }

    @Roles('ADMIN', 'SALES_MANAGER')
    @Patch('pipeline/lost-reasons/:reasonId')
    @RateLimit({ limit: 60, windowSeconds: 60 })
    updateLostReason(
        @CurrentUser() auth: AuthContext,
        @Param('reasonId', { schema: lostReasonIdSchema }) reasonId: number,
        @Body({ schema: updateLostReasonSchema }) body: UpdateLostReasonBody,
        @Ip() ip: string,
    ) {
        return this.pipeline.updateLostReason(auth, reasonId, body, ip);
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
        return this.pipeline.moveStage(auth, id, body.stage, body.date);
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

    /** Closes the open opportunity as won with the payment agreed. Closers, managers and admins. */
    @Roles('ADMIN', 'SALES_MANAGER', 'CLOSER')
    @Post('leads/:id/opportunity/won')
    @HttpCode(200)
    @RateLimit(MARKS)
    markWon(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: markWonSchema }) body: MarkWonBody,
        @Ip() ip: string | undefined,
    ) {
        return this.pipeline.markWon(auth, id, body, { ip });
    }

    /** Records or updates the payment of the lead's latest won deal (instalments collected, a correction). */
    @Roles('ADMIN', 'SALES_MANAGER', 'CLOSER')
    @Put('leads/:id/enrolment')
    @RateLimit(MARKS)
    saveEnrolment(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: enrolmentSchema }) body: EnrolmentBody,
        @Ip() ip: string | undefined,
    ) {
        return this.pipeline.saveEnrolment(auth, id, body, { ip });
    }
}
