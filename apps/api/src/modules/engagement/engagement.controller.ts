import { Body, Controller, Get, HttpCode, Ip, Param, Patch, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type DoNotContactBody, doNotContactSchema, leadIdSchema } from '@modules/leads';
import {
    type BulkTaskBody,
    bulkTaskSchema,
    type CreateOutcomeBody,
    createOutcomeSchema,
    outcomeIdSchema,
    type UpdateOutcomeBody,
    updateOutcomeSchema,
    type CreateTaskBody,
    createTaskSchema,
    type LogActivityBody,
    logActivitySchema,
    taskIdSchema,
    type UpdateTaskBody,
    updateTaskSchema,
} from './engagement.schemas.js';
import { EngagementService } from './engagement.service.js';

const WRITES = { limit: 60, windowSeconds: 60 } as const;

/**
 * Calls, messages and notes on a lead, the outcomes to log them with, and follow-up tasks.
 * Who may touch a lead follows the leads API: a BDA their own leads, a closer the leads in play.
 */
@Controller()
export class EngagementController {
    constructor(private readonly engagement: EngagementService) {}

    /** The outcomes the log-a-call form offers. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('engagement/outcomes')
    outcomes() {
        return this.engagement.listOutcomes();
    }

    /** Every outcome, retired ones too, with what logging it does and how often it was used. For the settings editor. */
    @Roles('ADMIN', 'SALES_MANAGER')
    @Get('engagement/outcomes/all')
    allOutcomes() {
        return this.engagement.listOutcomesForAdmin();
    }

    @Roles('ADMIN', 'SALES_MANAGER')
    @Post('engagement/outcomes')
    @HttpCode(200)
    @RateLimit({ limit: 30, windowSeconds: 60 })
    createOutcome(@CurrentUser() auth: AuthContext, @Body({ schema: createOutcomeSchema }) body: CreateOutcomeBody, @Ip() ip: string) {
        return this.engagement.createOutcome(auth, body, ip);
    }

    @Roles('ADMIN', 'SALES_MANAGER')
    @Patch('engagement/outcomes/:outcomeId')
    @RateLimit({ limit: 60, windowSeconds: 60 })
    updateOutcome(
        @CurrentUser() auth: AuthContext,
        @Param('outcomeId', { schema: outcomeIdSchema }) outcomeId: number,
        @Body({ schema: updateOutcomeSchema }) body: UpdateOutcomeBody,
        @Ip() ip: string,
    ) {
        return this.engagement.updateOutcome(auth, outcomeId, body, ip);
    }

    /** The lead's logged activities (with their notes) and its tasks. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get('leads/:id/engagement')
    forLead(@CurrentUser() auth: AuthContext, @Param('id', { schema: leadIdSchema }) id: string) {
        return this.engagement.getForLead(auth, id);
    }

    /** Logs a call, message or note. Returns the refreshed lead, like GET /leads/:id. */
    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/:id/activities')
    @HttpCode(200)
    @RateLimit(WRITES)
    logActivity(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: logActivitySchema }) body: LogActivityBody,
    ) {
        return this.engagement.logActivity(auth, id, body);
    }

    /** Adds the same follow-up to many leads at once. Answers how many were added and why any were skipped. */
    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/tasks/bulk')
    @HttpCode(200)
    @RateLimit({ limit: 20, windowSeconds: 60 })
    createTasks(@CurrentUser() auth: AuthContext, @Body({ schema: bulkTaskSchema }) body: BulkTaskBody) {
        return this.engagement.createTasks(auth, body);
    }

    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/:id/tasks')
    @HttpCode(200)
    @RateLimit(WRITES)
    createTask(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: createTaskSchema }) body: CreateTaskBody,
    ) {
        return this.engagement.createTask(auth, id, body);
    }

    /**
     * Marks the lead do-not-contact (or allows contact again, managers only). Marking cancels the lead's open follow-ups.
     * Returns the refreshed lead, like GET /leads/:id.
     */
    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('leads/:id/do-not-contact')
    @HttpCode(200)
    @RateLimit(WRITES)
    setDoNotContact(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: doNotContactSchema }) body: DoNotContactBody,
        @Ip() ip: string,
    ) {
        return this.engagement.setDoNotContact(auth, id, body, ip);
    }

    /** Reschedule, rename or reassign an open follow-up. Returns the refreshed task list, like the other task calls. */
    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Patch('tasks/:taskId')
    @RateLimit(WRITES)
    update(
        @CurrentUser() auth: AuthContext,
        @Param('taskId', { schema: taskIdSchema }) taskId: string,
        @Body({ schema: updateTaskSchema }) body: UpdateTaskBody,
    ) {
        return this.engagement.updateTask(auth, taskId, body);
    }

    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('tasks/:taskId/complete')
    @HttpCode(200)
    @RateLimit(WRITES)
    complete(@CurrentUser() auth: AuthContext, @Param('taskId', { schema: taskIdSchema }) taskId: string) {
        return this.engagement.completeTask(auth, taskId);
    }

    @Roles('ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER')
    @Post('tasks/:taskId/cancel')
    @HttpCode(200)
    @RateLimit(WRITES)
    cancel(@CurrentUser() auth: AuthContext, @Param('taskId', { schema: taskIdSchema }) taskId: string) {
        return this.engagement.cancelTask(auth, taskId);
    }
}
