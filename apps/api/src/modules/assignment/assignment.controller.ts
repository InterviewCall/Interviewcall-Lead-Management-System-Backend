import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import {
    type BulkAssignBody,
    bulkAssignSchema,
    type HandoverBody,
    handoverSchema,
} from './assignment.schemas.js';
import { AssignmentService } from './assignment.service.js';
import type { AssigneeView, BatchView, MoveResult } from './assignment.types.js';

const MOVES = { limit: 30, windowSeconds: 60 } as const;

/** Giving leads to other people: the admin and the sales manager. */
@Roles('ADMIN', 'SALES_MANAGER')
@Controller('assignment')
export class AssignmentController {
    constructor(private readonly assignment: AssignmentService) {}

    /** Who leads can be given to. */
    @Get('assignees')
    assignees(@CurrentUser() auth: AuthContext): Promise<{ assignees: AssigneeView[] }> {
        return this.assignment.assignees(auth);
    }

    /** The daily WorkR lists, with how many leads of each still wait to be handed over. */
    @Get('batches')
    batches(@CurrentUser() auth: AuthContext): Promise<{ batches: BatchView[] }> {
        return this.assignment.batches(auth);
    }

    /** Gives all waiting leads of one daily list to one person. */
    @Post('handover')
    @HttpCode(200)
    @RateLimit(MOVES)
    handOver(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: handoverSchema }) body: HandoverBody,
        @Ip() ip: string | undefined,
    ): Promise<MoveResult> {
        return this.assignment.handOver(auth, body, { ip });
    }

    /** Gives the chosen leads to one person. */
    @Post('bulk')
    @HttpCode(200)
    @RateLimit(MOVES)
    bulkAssign(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: bulkAssignSchema }) body: BulkAssignBody,
        @Ip() ip: string | undefined,
    ): Promise<MoveResult> {
        return this.assignment.bulkAssign(auth, body, { ip });
    }
}
