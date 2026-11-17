import { Body, Controller, Get, HttpCode, Ip, Post, Query } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import {
    type BulkAssignBody,
    bulkAssignSchema,
    type DistributeBody,
    distributeSchema,
    type HandoverBody,
    handoverSchema,
    type LeaveBody,
    leaveSchema,
    type MoveFromPersonBody,
    moveFromPersonSchema,
    type OwnedQuery,
    ownedQuerySchema,
    type QueueQuery,
    queueQuerySchema,
} from './assignment.schemas.js';
import { AssignmentService } from './assignment.service.js';
import type {
    AssigneeView,
    BatchView,
    DistributeResult,
    HistoryView,
    LoadsView,
    MoveResult,
    QueueView,
} from './assignment.types.js';

const MOVES = { limit: 30, windowSeconds: 60 } as const;

/** Giving leads to other people: the admin and the sales manager. */
@Roles('ADMIN', 'SALES_MANAGER')
@Controller('assignment')
export class AssignmentController {
    constructor(private readonly assignment: AssignmentService) {}

    /** The leads waiting for someone, best first, with the counts the tabs show. */
    @Get('queue')
    queue(@CurrentUser() auth: AuthContext, @Query({ schema: queueQuerySchema }) query: QueueQuery): Promise<QueueView> {
        return this.assignment.queue(auth, query);
    }

    /** How many leads wait for someone (the sidebar pill). */
    @Get('summary')
    summary(@CurrentUser() auth: AuthContext): Promise<{ waiting: number }> {
        return this.assignment.waiting(auth);
    }

    /** The BDAs with their load, who is away, and where the round robin carries on from. */
    @Get('loads')
    loads(@CurrentUser() auth: AuthContext): Promise<LoadsView> {
        return this.assignment.loads(auth);
    }

    /** Recent manual and equal distributions. */
    @Get('history')
    history(@CurrentUser() auth: AuthContext): Promise<{ history: HistoryView[] }> {
        return this.assignment.history(auth);
    }

    /** Shares the chosen waiting leads equally between the chosen BDAs. */
    @Post('distribute')
    @HttpCode(200)
    @RateLimit(MOVES)
    distribute(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: distributeSchema }) body: DistributeBody,
        @Ip() ip: string | undefined,
    ): Promise<DistributeResult> {
        return this.assignment.distribute(auth, body, { ip });
    }

    /** How many leads a person holds that a hand-over would move. */
    @Get('owned')
    owned(
        @CurrentUser() auth: AuthContext,
        @Query({ schema: ownedQuerySchema }) query: OwnedQuery,
    ): Promise<{ count: number }> {
        return this.assignment.ownedCount(auth, query.userId);
    }

    /** Moves everything a person owns (not yet enrolled) to the chosen people, round robin. For someone leaving. */
    @Post('move-from')
    @HttpCode(200)
    @RateLimit(MOVES)
    moveFrom(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: moveFromPersonSchema }) body: MoveFromPersonBody,
        @Ip() ip: string | undefined,
    ): Promise<DistributeResult> {
        return this.assignment.moveFromPerson(auth, body, { ip });
    }

    /** Sets the last day a BDA is away, or clears it. */
    @Post('leave')
    @HttpCode(200)
    @RateLimit(MOVES)
    leave(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: leaveSchema }) body: LeaveBody,
        @Ip() ip: string | undefined,
    ): Promise<{ ok: true }> {
        return this.assignment.setLeave(auth, body, { ip });
    }

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
