import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext, Role } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { IamService } from '@modules/iam';
import { type BulkResult, type DoNotContactBody, LeadsService, runBulk } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { EngagementRepository } from './engagement.repository.js';
import {
    type BulkTaskBody,
    type CreateOutcomeBody,
    type CreateTaskBody, type LogActivityBody, type OutcomeEffect, parseEffect, type UpdateOutcomeBody, type UpdateTaskBody } from './engagement.schemas.js';
import { EXHAUSTED_AFTER_ATTEMPTS, type OutcomeAdminRow, type OutcomeRow, type OutcomeView, type TaskRow } from './engagement.types.js';

const MINUTE = 60_000;
const YEAR = 366 * 24 * 60 * MINUTE;

@Injectable()
export class EngagementService {
    constructor(
        private readonly repository: EngagementRepository,
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    private badField(field: string, message: string): BadRequestException {
        return new BadRequestException({ code: 'VALIDATION_FAILED', message, fields: { [field]: message } });
    }

    private async actorId(auth: AuthContext): Promise<bigint | null> {
        return (await this.iam.getStaffRef(auth.publicId))?.id ?? null;
    }

    private checkDue(dueAt: Date, field: string): void {
        const now = Date.now();
        if (dueAt.getTime() < now - 5 * MINUTE) throw this.badField(field, 'Choose a time that has not passed');
        if (dueAt.getTime() > now + YEAR) throw this.badField(field, 'Choose a time within the next year');
    }

    private toOutcomeView(row: OutcomeRow): OutcomeView {
        const effect = parseEffect(row.effect);
        return {
            id: row.id,
            name: row.name,
            connected: effect.connected ?? null,
            conversation: (effect.conversation ?? effect.connected) === true,
            requiresFollowup: row.requiresFollowup,
            ends: effect.closeAs === 'LOST' || effect.lifecycle === 'NOT_INTERESTED',
        };
    }

    // ---- the outcome editor ----

    /** The editor's view of an outcome: the stored effect spelled out as plain fields. */
    private toAdminView(row: OutcomeAdminRow) {
        const effect = parseEffect(row.effect);
        return {
            id: row.id,
            name: row.name,
            isActive: row.isActive,
            sortOrder: row.sortOrder,
            requiresFollowup: row.requiresFollowup,
            connected: effect.connected ?? null,
            conversation: (effect.conversation ?? effect.connected) === true,
            countsAsAttempt: effect.countsAsAttempt === true,
            lifecycle: effect.lifecycle ?? null,
            lostReason: effect.closeAs === 'LOST' ? (effect.lostReason ?? null) : null,
            used: row.used,
        };
    }

    async listOutcomesForAdmin() {
        return (await this.repository.listOutcomesForAdmin()).map((row) => this.toAdminView(row));
    }

    /** Turns the editor's fields into the stored effect. A lost reason must be one of the active ones. */
    private async buildEffect(f: {
        connected: boolean | null;
        conversation: boolean;
        countsAsAttempt: boolean;
        lifecycle: 'ENGAGED_LEAD' | 'PROSPECT' | 'NOT_INTERESTED' | null;
        lostReason: string | null;
    }): Promise<OutcomeEffect> {
        if (f.lostReason !== null && !(await this.pipeline.listLostReasons()).some((r) => r.name === f.lostReason)) {
            throw this.badField('lostReason', 'Choose one of the lost reasons');
        }
        if (f.lostReason !== null && f.lifecycle !== null && f.lifecycle !== 'NOT_INTERESTED') {
            throw this.badField('lifecycle', 'A call that closes the lead as lost cannot make it Engaged or Prospect');
        }
        const effect: OutcomeEffect = {};
        if (f.connected !== null) effect.connected = f.connected;
        if (f.conversation !== (f.connected === true)) effect.conversation = f.conversation;
        if (f.countsAsAttempt) effect.countsAsAttempt = true;
        if (f.lifecycle) effect.lifecycle = f.lifecycle;
        if (f.lostReason !== null) {
            effect.closeAs = 'LOST';
            effect.lostReason = f.lostReason;
        }
        return effect;
    }

    async createOutcome(auth: AuthContext, body: CreateOutcomeBody, ip?: string) {
        if (await this.repository.findOutcomeNameTaken(body.name)) throw this.badField('name', 'An outcome with this name already exists');
        const effect = await this.buildEffect({ ...body, conversation: body.conversation ?? body.connected === true });
        const id = await this.repository.createOutcome({
            name: body.name,
            effect,
            requiresFollowup: body.requiresFollowup,
            sortOrder: await this.repository.nextOutcomeOrder(),
        });
        await this.admin.audit({
            action: AuditAction.OutcomeCreated,
            actorId: await this.actorId(auth),
            entityType: 'outcome',
            entityId: String(id),
            detail: { name: body.name },
            ip: ip ?? null,
        });
        return this.listOutcomesForAdmin();
    }

    /** Changes only what is sent. Retiring an outcome hides it from the call form; the calls already logged keep it. */
    async updateOutcome(auth: AuthContext, id: number, body: UpdateOutcomeBody, ip?: string) {
        const row = await this.repository.findOutcomeAnyState(id);
        if (!row) throw new NotFoundException({ code: 'OUTCOME_NOT_FOUND', message: 'This outcome does not exist' });
        if (body.name !== undefined && body.name !== row.name && (await this.repository.findOutcomeNameTaken(body.name, id))) {
            throw this.badField('name', 'An outcome with this name already exists');
        }
        const now = this.toAdminView({ ...row, used: 0 });
        const touchesEffect = ['connected', 'conversation', 'countsAsAttempt', 'lifecycle', 'lostReason'].some((k) => k in body);
        const effect = touchesEffect
            ? await this.buildEffect({
                  connected: body.connected !== undefined ? body.connected : now.connected,
                  // Changing "connected" without saying otherwise keeps the conversation flag in step with it.
                  conversation: body.conversation ?? (body.connected !== undefined ? body.connected === true : now.conversation),
                  countsAsAttempt: body.countsAsAttempt ?? now.countsAsAttempt,
                  lifecycle: body.lifecycle !== undefined ? body.lifecycle : now.lifecycle,
                  lostReason: body.lostReason !== undefined ? body.lostReason : now.lostReason,
              })
            : undefined;
        await this.repository.updateOutcome(id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.requiresFollowup !== undefined ? { requiresFollowup: body.requiresFollowup } : {}),
            ...(effect ? { effect } : {}),
        });
        await this.admin.audit({
            action: AuditAction.OutcomeUpdated,
            actorId: await this.actorId(auth),
            entityType: 'outcome',
            entityId: String(id),
            detail: { ...body, was: row.name },
            ip: ip ?? null,
        });
        return this.listOutcomesForAdmin();
    }

    async listOutcomes(): Promise<OutcomeView[]> {
        return (await this.repository.listOutcomes()).map((row) => this.toOutcomeView(row));
    }

    // ---- reading ----

    /** The activities and tasks on one lead, newest activity first and open tasks first. */
    async getForLead(auth: AuthContext, leadPublicId: string) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        return this.view(lead.id);
    }

    private async view(leadId: bigint) {
        const [activities, tasks] = await Promise.all([this.repository.listActivities(leadId, 100), this.repository.listTasks(leadId)]);
        const names = await this.iam.getStaffNames([
            ...activities.map((a) => a.userId),
            ...tasks.flatMap((t) => (t.assigneeId === null ? [] : [t.assigneeId])),
        ]);
        const now = Date.now();
        return {
            activities: activities.map((a) => ({
                id: String(a.id),
                kind: a.kind,
                outcome: a.outcome ? { id: a.outcome.id, name: a.outcome.name } : null,
                connected: a.connected,
                attemptNo: a.attemptNo,
                notes: a.notes,
                nextFollowupAt: a.nextFollowupAt?.toISOString() ?? null,
                at: a.occurredAt.toISOString(),
                by: names.get(a.userId) ?? 'A teammate',
            })),
            tasks: tasks.map((t) => ({
                id: String(t.id),
                type: t.type,
                status: t.status,
                title: t.title,
                dueAt: t.dueAt.toISOString(),
                overdue: t.status === 'OPEN' && t.dueAt.getTime() < now,
                completedAt: t.completedAt?.toISOString() ?? null,
                assignee: t.assigneeId === null ? null : (names.get(t.assigneeId) ?? 'A teammate'),
            })),
        };
    }

    // ---- logging ----

    /**
     * Logs a call, message or note on a lead, and everything that follows from it:
     *  - a call needs an outcome; the outcome's effect can move the contact stage or close the opportunity;
     *  - an unanswered call counts as an attempt, and three in a row on a lead who never connected make it Exhausted;
     *  - a connected call resets the attempts;
     *  - the lead's earlier open follow-ups are answered by a call, and the next step (when given) becomes the new one.
     * Returns the refreshed lead, like the other markings.
     */
    async logActivity(auth: AuthContext, leadPublicId: string, body: LogActivityBody) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);

        let outcome: OutcomeRow | null = null;
        let effect: OutcomeEffect = {};
        if (body.kind === 'CALL') {
            if (body.outcomeId === null) throw this.badField('outcomeId', 'Choose what happened on the call');
            outcome = await this.repository.findOutcome(body.outcomeId);
            if (!outcome) throw this.badField('outcomeId', 'Choose one of the listed outcomes');
            effect = parseEffect(outcome.effect);
        } else if (body.outcomeId !== null) {
            throw this.badField('outcomeId', 'Only a call has an outcome');
        }
        if (body.kind === 'NOTE' && body.notes === null) throw this.badField('notes', 'Write the note');

        const ends = effect.closeAs === 'LOST' || effect.lifecycle === 'NOT_INTERESTED';
        const nextStep = ends ? null : body.nextStep;
        if (!ends && outcome?.requiresFollowup && nextStep === null) {
            throw this.badField('nextStep', 'Choose when to follow up');
        }
        if (nextStep) this.checkDue(nextStep.dueAt, 'nextStep');

        const actorId = await this.actorId(auth);
        if (actorId === null) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: 'Your account could not be found' });

        // The stage move has its own rules (who may close, whether anything is open), so it goes first: if it is refused, nothing else happens.
        if (body.stage !== null) await this.pipeline.moveStage(auth, leadPublicId, body.stage);

        const at = new Date();
        const attempts = await this.leads.recordTouch(lead.id, at, {
            connected: body.kind === 'CALL' ? (effect.connected ?? null) : null,
            countsAsAttempt: body.kind === 'CALL' && effect.countsAsAttempt === true,
        });
        const attemptNo = effect.countsAsAttempt === true ? attempts : null;
        const activityId = await this.repository.createActivity({
            leadId: lead.id,
            opportunityId: await this.pipeline.openOpportunityId(lead.id),
            userId: actorId,
            kind: body.kind,
            outcomeId: outcome?.id ?? null,
            connected: body.kind === 'CALL' ? (effect.connected ?? null) : null,
            attemptNo,
            notes: body.notes,
            nextFollowupAt: nextStep?.dueAt ?? null,
        });
        await this.timeline.append({
            leadId: lead.id,
            type: TimelineEvent.ActivityLogged,
            actorType: 'USER',
            actorId,
            data: { activity: String(activityId), kind: body.kind, outcome: outcome?.name ?? null, attempt: attemptNo, connected: body.kind === 'CALL' ? (effect.connected ?? null) : null },
            occurredAt: at,
        });

        if (body.temperature !== null) await this.leads.setTemperature(lead.id, body.temperature, actorId);

        // What the outcome does to the lead.
        if (effect.lifecycle) await this.leads.applyOutcomeLifecycle(lead.id, effect.lifecycle, actorId);
        // The first real conversation has happened ("call me later" is not one): Call 1 Pending becomes Call 1. A call nobody picked (DNP) does not count,
        // and later calls leave the stage where it is (it moves on when the test is scheduled).
        if (body.kind === 'CALL' && (effect.conversation ?? effect.connected) === true && !ends) {
            await this.pipeline.advanceIfAt(lead.id, 'CALL_1_PENDING', 'CALL_1', actorId);
        }
        if (effect.closeAs === 'LOST' && effect.lostReason) await this.pipeline.closeOpenAsLost(lead.id, effect.lostReason, actorId);
        if (effect.countsAsAttempt === true && attempts >= EXHAUSTED_AFTER_ATTEMPTS && !(await this.repository.hasConnectedActivity(lead.id))) {
            await this.leads.applyOutcomeLifecycle(lead.id, 'EXHAUSTED_NOT_CONNECTED', actorId);
        }

        // Follow-ups: a call answers the ones that were waiting; an ending outcome cancels them; the next step becomes the new one.
        if (ends) await this.repository.closeOpenFollowups(lead.id, 'CANCELLED', at);
        else if (body.kind === 'CALL') await this.repository.closeOpenFollowups(lead.id, 'DONE', at);
        if (nextStep) await this.addFollowUp(lead.id, lead.ownerId ?? actorId, actorId, nextStep.title, nextStep.dueAt);
        await this.refreshNextFollowup(lead.id);

        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }

    // ---- tasks ----

    private async addFollowUp(leadId: bigint, assigneeId: bigint | null, actorId: bigint | null, title: string, dueAt: Date): Promise<void> {
        const taskId = await this.repository.createTask({ leadId, assigneeId, type: 'FOLLOW_UP', title, dueAt, createdById: actorId });
        await this.timeline.append({
            leadId,
            type: TimelineEvent.TaskCreated,
            actorType: actorId === null ? 'SYSTEM' : 'USER',
            actorId,
            data: { task: String(taskId), dueAt: dueAt.toISOString() },
        });
    }

    /** The lead shows the due time of its earliest open follow-up. */
    private async refreshNextFollowup(leadId: bigint): Promise<void> {
        await this.leads.setNextFollowup(leadId, await this.repository.earliestOpenFollowup(leadId));
    }

    private dncRefusal(): ConflictException {
        return new ConflictException({ code: 'DO_NOT_CONTACT', message: 'This lead is marked do not contact. Allow contact again before adding a follow-up' });
    }

    async setDoNotContact(auth: AuthContext, leadPublicId: string, body: DoNotContactBody, ip?: string) {
        const { leadId, changed } = await this.leads.setDoNotContact(auth, leadPublicId, body.value, body.reason, { ip });
        if (changed && body.value) {
            await this.repository.closeOpenFollowups(leadId, 'CANCELLED', new Date());
            await this.refreshNextFollowup(leadId);
        }
        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }

    async createTask(auth: AuthContext, leadPublicId: string, body: CreateTaskBody) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        if (lead.doNotContact) throw this.dncRefusal();
        this.checkDue(body.dueAt, 'dueAt');
        const actorId = await this.actorId(auth);
        await this.addFollowUp(lead.id, lead.ownerId ?? actorId, actorId, body.title, body.dueAt);
        await this.refreshNextFollowup(lead.id);
        return this.view(lead.id);
    }

    /**
     * Adds the same follow-up to many leads (the bulk bar on the leads list). Each task goes to that lead's owner, or
     * to the person adding it when the lead has no owner. Leads this person may not change are skipped and counted.
     */
    async createTasks(auth: AuthContext, body: BulkTaskBody): Promise<BulkResult> {
        this.checkDue(body.dueAt, 'dueAt');
        const actorId = await this.actorId(auth);
        return runBulk([...new Set(body.leadIds)], async (publicId) => {
            const lead = await this.leads.resolveForMarking(auth, publicId);
            if (lead.doNotContact) throw this.dncRefusal();
            await this.addFollowUp(lead.id, lead.ownerId ?? actorId, actorId, body.title, body.dueAt);
            await this.refreshNextFollowup(lead.id);
            return true;
        });
    }

    private async resolveTask(auth: AuthContext, taskId: string): Promise<TaskRow> {
        const task = await this.repository.findTask(BigInt(taskId));
        if (!task || (task.type !== 'FOLLOW_UP' && task.type !== 'SCHEDULED_CALL')) {
            throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'This task does not exist or you cannot open it' });
        }
        // Whoever may mark the lead may close its tasks; anyone else gets the same answer as for a task that is not there.
        await this.leads.resolveForMarking(auth, task.lead.publicId);
        return task;
    }

    private async finishTask(auth: AuthContext, taskId: string, status: 'DONE' | 'CANCELLED') {
        const task = await this.resolveTask(auth, taskId);
        if (status === 'CANCELLED' && task.type !== 'FOLLOW_UP') {
            throw new ConflictException({ code: 'TASK_NOT_CANCELLABLE', message: 'A booked call is cancelled by the booking, not here' });
        }
        const actorId = await this.actorId(auth);
        if (!(await this.repository.closeTask(task.id, status, new Date()))) {
            throw new ConflictException({ code: 'TASK_CLOSED', message: 'This task was already closed. Reload to see it' });
        }
        await this.timeline.append({
            leadId: task.leadId,
            type: status === 'DONE' ? TimelineEvent.TaskDone : TimelineEvent.TaskCancelled,
            actorType: 'USER',
            actorId,
            data: { task: String(task.id) },
        });
        await this.refreshNextFollowup(task.leadId);
        return this.view(task.leadId);
    }

    /**
     * Reschedules, renames or reassigns an open follow-up. Anyone who may mark the lead may change the time and the
     * wording; only managers and admins hand it to someone else (a manager to a BDA or manager, an admin to anyone
     * who can work leads). Booked calls move with their booking, so they are not changed here.
     */
    async updateTask(auth: AuthContext, taskId: string, body: UpdateTaskBody) {
        const task = await this.resolveTask(auth, taskId);
        if (task.type !== 'FOLLOW_UP') {
            throw new ConflictException({ code: 'TASK_NOT_EDITABLE', message: 'A booked call moves with its booking, not here' });
        }
        if (task.status !== 'OPEN') {
            throw new ConflictException({ code: 'TASK_CLOSED', message: 'This task was already closed. Reload to see it' });
        }
        if (body.dueAt) this.checkDue(body.dueAt, 'dueAt');
        let assigneeId: bigint | undefined;
        if (body.assigneeId !== undefined) {
            if (auth.role !== 'ADMIN' && auth.role !== 'SALES_MANAGER') {
                throw new ForbiddenException({ code: 'REASSIGN_NOT_ALLOWED', message: 'Only a manager or admin can give a follow-up to someone else' });
            }
            const allowed: Role[] = auth.role === 'ADMIN' ? ['ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER'] : ['SALES_MANAGER', 'BDA', 'CLOSER'];
            const person = await this.iam.getStaffRef(body.assigneeId);
            if (!person || !person.isActive || !allowed.includes(person.role)) {
                throw this.badField('assigneeId', 'Choose an active teammate');
            }
            assigneeId = person.id;
        }
        const actorId = await this.actorId(auth);
        const changes = { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.dueAt ? { dueAt: body.dueAt } : {}), ...(assigneeId !== undefined ? { assigneeId } : {}) };
        if (!(await this.repository.updateOpenTask(task.id, changes))) {
            throw new ConflictException({ code: 'TASK_CLOSED', message: 'This task was already closed. Reload to see it' });
        }
        await this.timeline.append({
            leadId: task.leadId,
            type: TimelineEvent.TaskUpdated,
            actorType: 'USER',
            actorId,
            data: {
                task: String(task.id),
                ...(body.dueAt ? { dueAt: body.dueAt.toISOString() } : {}),
                ...(body.title !== undefined ? { renamed: true } : {}),
                ...(assigneeId !== undefined ? { reassigned: true } : {}),
            },
        });
        await this.refreshNextFollowup(task.leadId);
        return this.view(task.leadId);
    }

    completeTask(auth: AuthContext, taskId: string) {
        return this.finishTask(auth, taskId, 'DONE');
    }

    cancelTask(auth: AuthContext, taskId: string) {
        return this.finishTask(auth, taskId, 'CANCELLED');
    }

    // ---- used by the VSL and hand-over code ----

    /**
     * A booked VSL call becomes a task for the lead's owner, due at the slot. One per booking, so
     * repeating the event does nothing more. A lead with no owner yet has an unassigned task; hand-over gives it to the new owner.
     */
    async openScheduledCall(input: { leadId: bigint; ownerId: bigint | null; bookingRef: string; slotStartAt: Date; slotLabel: string }): Promise<{ id: bigint }> {
        return this.repository.upsertScheduledCall({
            leadId: input.leadId,
            bookingRef: input.bookingRef,
            title: `Counselling call · ${input.slotLabel}`.slice(0, 150),
            dueAt: input.slotStartAt,
            assigneeId: input.ownerId,
        });
    }

    /** The VSL marked the call done: the task is done too. */
    async completeScheduledCall(bookingRef: string, at: Date): Promise<void> {
        await this.repository.closeScheduledCall(bookingRef, at);
    }

    private callTitle(slotLabel: string): string {
        return `Counselling call · ${slotLabel}`.slice(0, 150);
    }

    /** The VSL cancelled the booking: its open task is cancelled and the alerts about it are cleared. */
    cancelScheduledCall(bookingRef: string, at: Date): Promise<boolean> {
        return this.repository.cancelScheduledCall(bookingRef, at);
    }

    /** The VSL moved the call. Returns the task's id, or null when no open task was found. */
    rescheduleScheduledCall(bookingRef: string, slotStartAt: Date, slotLabel: string): Promise<bigint | null> {
        return this.repository.moveScheduledCall(bookingRef, slotStartAt, this.callTitle(slotLabel));
    }

    /** The VSL un-marked the call as done: the task is open again. */
    reopenScheduledCall(bookingRef: string): Promise<boolean> {
        return this.repository.reopenScheduledCall(bookingRef);
    }

    scheduledCallStates(bookingRefs: string[]) {
        return this.repository.scheduledCallStates(bookingRefs);
    }

    retimeScheduledCall(taskId: bigint, slotStartAt: Date, slotLabel: string): Promise<void> {
        return this.repository.retimeScheduledCall(taskId, slotStartAt, this.callTitle(slotLabel));
    }

    /** The open tasks of these leads go to their new owner. */
    /** A merge: the duplicate's calls, notes, follow-ups and alerts belong to the kept lead, whose next follow-up is recomputed. */
    async moveLeadRecords(fromLeadId: bigint, toLeadId: bigint): Promise<void> {
        await this.repository.moveLeadRecords(fromLeadId, toLeadId);
        await this.refreshNextFollowup(toLeadId);
    }

    /** Erasure of a lead: its notes and task wording are removed and its open follow-ups cancelled. */
    async eraseLeadRecords(leadId: bigint): Promise<void> {
        await this.repository.eraseLeadRecords(leadId, new Date());
        await this.refreshNextFollowup(leadId);
    }

    reassignOpenTasks(leadIds: bigint[], ownerId: bigint): Promise<void> {
        return this.repository.reassignOpenTasks(leadIds, ownerId);
    }

    // ---- read side of the My day view (the My day module composes these) ----

    dueTasksOf(assigneeId: bigint | null, before: Date, take: number) {
        return this.repository.listDueTasks(assigneeId, before, take);
    }

    bookedCalls(from: Date, to: Date, assigneeId: bigint | null) {
        return this.repository.listBookedCalls(from, to, assigneeId);
    }

    callsPerDay(from: Date, to: Date, userId: bigint | null) {
        return this.repository.callsPerDay(from, to, userId);
    }
}
