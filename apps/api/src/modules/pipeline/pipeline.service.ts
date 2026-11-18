import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { addDays, istDate, startOfIstMonth } from './ist.js';
import { AdminService, AuditAction } from '@modules/admin';
import { IamService } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { PipelineRepository } from './pipeline.repository.js';
import type { BoardQuery, CreateLostReasonBody, EnrolmentBody, MarkWonBody, UpdateLostReasonBody } from './pipeline.schemas.js';
import {
    type DatedStageName,
    FIRST_STAGE,
    isDatedStage,
    type LostReasonView,
    type OpenedOpportunity,
    type OpenOpportunityInput,
    OPPORTUNITY_STAGES,
    type OpportunityStageName,
} from './pipeline.types.js';

/** A date column as YYYY-MM-DD, or null. */
const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

@Injectable()
export class PipelineService {
    constructor(
        private readonly repository: PipelineRepository,
        private readonly leads: LeadsService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    /**
     * Opens the lead's opportunity at the first stage (Call 1 Pending) unless it already has an
     * open one. Safe to repeat.
     */
    openOpportunity(input: OpenOpportunityInput): Promise<OpenedOpportunity> {
        return this.repository.open({ ...input, stage: input.stage ?? FIRST_STAGE });
    }

    /** Keeps each lead's open opportunity with the lead's owner after the lead changes hands. */
    /** A merge: the duplicate's opportunities move to the kept lead (see the repository for the open-one rule). */
    absorbOpportunities(keepId: bigint, dropId: bigint): Promise<void> {
        return this.repository.absorbOpportunities(keepId, dropId);
    }

    reassignOpenOpportunities(leadIds: bigint[], ownerId: bigint): Promise<void> {
        return this.repository.reassignOpen(leadIds, ownerId);
    }

    /** A VSL booking: the call time shows on the lead's open opportunity. */
    setScheduledCall(leadId: bigint, at: Date | null): Promise<boolean> {
        return this.repository.setScheduledCall(leadId, at);
    }

    /** The id of the lead's open opportunity, or null. */
    async openOpportunityId(leadId: bigint): Promise<bigint | null> {
        return (await this.repository.findOpenFor(leadId))?.id ?? null;
    }

    /**
     * Closes the lead's open opportunity as lost because of a logged call (for example a wrong number).
     * False when there is no open opportunity or the reason is not one of the configured ones.
     */
    async closeOpenAsLost(leadId: bigint, reasonName: string, actorId: bigint | null): Promise<boolean> {
        const open = await this.repository.findOpenFor(leadId);
        if (!open) return false;
        const reason = await this.repository.findLostReasonByName(reasonName);
        if (!reason) return false;
        if (!(await this.repository.markLost(open.id, open.stage, reason.id, null))) return false;
        await this.timeline.append({
            leadId,
            type: TimelineEvent.OpportunityLost,
            actorType: actorId === null ? 'SYSTEM' : 'USER',
            actorId,
            data: { stage: open.stage, reason: reason.name, hasNote: false, via: 'CALL' },
        });
        return true;
    }

    /**
     * Moves the lead's open opportunity from `from` to `to`, only if it is still at `from` (a logged call
     * brings a lead forward, never back, and never past where a person already put it). Returns whether it moved.
     */
    async advanceIfAt(leadId: bigint, from: OpportunityStageName, to: OpportunityStageName, actorId: bigint | null): Promise<boolean> {
        const open = await this.repository.findOpenFor(leadId);
        if (!open || open.stage !== from) return false;
        if (!(await this.repository.moveStage(open.id, from, to, actorId))) return false;
        await this.timeline.append({
            leadId,
            type: TimelineEvent.OpportunityStageChanged,
            actorType: actorId === null ? 'SYSTEM' : 'USER',
            actorId,
            data: { from, to, via: 'CALL' },
        });
        return true;
    }

    /**
     * The board: every stage with how many open opportunities sit there and the newest cards. Closed Won
     * holds what was won this month (India's calendar). The win rate is won over won plus lost this month,
     * or null when nothing has closed yet.
     */
    async board(auth: AuthContext, query: BoardQuery) {
        const { rows, owners } = await this.leads.boardRows(
            auth,
            { temperature: query.temperature, ownerId: query.ownerId },
            query.perColumn,
            startOfIstMonth(new Date()),
        );
        const columns = OPPORTUNITY_STAGES.map((stage) => ({
            stage,
            count: rows.counts[stage] ?? 0,
            cards: (rows.cards[stage] ?? []).map((row) => ({
                id: row.lead.publicId,
                name: row.lead.fullName,
                company: row.lead.currentCompany,
                domain: row.lead.domain,
                source: row.lead.firstSource.name,
                temperature: row.lead.temperature,
                owner: row.lead.owner ? { id: row.lead.owner.publicId, name: row.lead.owner.name } : null,
                next: row.scheduledCallAt
                    ? { kind: 'booked' as const, at: row.scheduledCallAt.toISOString() }
                    : row.lead.nextFollowupAt
                      ? { kind: 'task' as const, at: row.lead.nextFollowupAt.toISOString() }
                      : { kind: 'none' as const, at: null },
                stageChangedAt: row.stageChangedAt.toISOString(),
                // The day the stage is about: when the test or session is scheduled, or when the deal was won.
                stageOn: dayOf(row.stage === 'TEST' ? row.testOn : row.stage === 'PSYCHOMETRIC_SESSION' ? row.psychometricOn : row.stage === 'CLOSED_WON' ? row.wonOn : null),
            })),
        }));
        const won = rows.counts.CLOSED_WON ?? 0;
        const closed = won + rows.lostThisMonth;
        return {
            columns,
            open: columns.reduce((n, c) => (c.stage === 'CLOSED_WON' ? n : n + c.count), 0),
            wonThisMonth: won,
            lostThisMonth: rows.lostThisMonth,
            winRate: closed === 0 ? null : (won / closed) * 100,
            owners,
        };
    }

    eraseLeadNotes(leadId: bigint): Promise<void> {
        return this.repository.eraseLeadNotes(leadId);
    }

    listLostReasonsForAdmin() {
        return this.repository.listLostReasonsForAdmin();
    }

    async createLostReason(auth: AuthContext, body: CreateLostReasonBody, ip?: string) {
        if (await this.repository.findLostReasonNameTaken(body.name)) {
            throw new ConflictException({ code: 'LOST_REASON_EXISTS', message: 'A reason with this name already exists' });
        }
        const id = await this.repository.createLostReason(body.name, await this.repository.nextLostReasonOrder());
        await this.admin.audit({
            action: AuditAction.LostReasonCreated,
            actorId: await this.actorId(auth),
            entityType: 'lost_reason',
            entityId: String(id),
            detail: { name: body.name },
            ip: ip ?? null,
        });
        return this.repository.listLostReasonsForAdmin();
    }

    /**
     * Renames, retires or reorders a lost reason. A reason that a call outcome closes leads with (found by name) cannot
     * be renamed or retired until that outcome is changed, or the outcome would stop closing leads.
     */
    async updateLostReason(auth: AuthContext, id: number, body: UpdateLostReasonBody, ip?: string) {
        const reason = await this.repository.findLostReasonAnyState(id);
        if (!reason) throw new NotFoundException({ code: 'LOST_REASON_NOT_FOUND', message: 'This reason does not exist' });
        const renames = body.name !== undefined && body.name !== reason.name;
        const retires = body.isActive === false && reason.isActive;
        if (renames || retires) {
            if ((await this.repository.outcomesUsingLostReason(reason.name)) > 0) {
                throw new ConflictException({
                    code: 'LOST_REASON_IN_USE',
                    message: `A call outcome closes leads with "${reason.name}". Change that outcome first`,
                });
            }
        }
        if (renames && (await this.repository.findLostReasonNameTaken(body.name!, id))) {
            throw new ConflictException({ code: 'LOST_REASON_EXISTS', message: 'A reason with this name already exists' });
        }
        await this.repository.updateLostReason(id, body);
        await this.admin.audit({
            action: AuditAction.LostReasonUpdated,
            actorId: await this.actorId(auth),
            entityType: 'lost_reason',
            entityId: String(id),
            detail: { ...body, was: reason.name },
            ip: ip ?? null,
        });
        return this.repository.listLostReasonsForAdmin();
    }

    listLostReasons(): Promise<LostReasonView[]> {
        return this.repository.listLostReasons();
    }

    private async actorId(auth: AuthContext): Promise<bigint | null> {
        return (await this.iam.getStaffRef(auth.publicId))?.id ?? null;
    }

    private async openFor(leadId: bigint) {
        const open = await this.repository.findOpenFor(leadId);
        if (!open) {
            throw new ConflictException({
                code: 'NO_OPEN_OPPORTUNITY',
                message: 'This lead has no open opportunity. Reopen it first',
            });
        }
        return open;
    }

    private changed(): never {
        throw new ConflictException({
            code: 'OPPORTUNITY_CHANGED',
            message: 'Someone else just changed this opportunity. Reload it and try again',
        });
    }

    /**
     * The day a move to a dated stage needs. A test or psychometric session is scheduled, so its day may be up to
     * a year ahead, and a little way back for a move recorded late. A win happened, so it cannot be in the future.
     * Days are India's calendar days.
     */
    private checkDay(stage: DatedStageName, day: string | null): string {
        const label = stage === 'TEST' ? 'the test date' : stage === 'PSYCHOMETRIC_SESSION' ? 'the date of the psychometric session' : 'the date it was won';
        if (day === null) throw this.badDate(`Choose ${label}`);
        const today = istDate(new Date());
        if (stage === 'CLOSED_WON') {
            if (day > today) throw this.badDate('The date it was won cannot be in the future');
            if (day < '2020-01-01') throw this.badDate('That date is too far back');
        } else {
            if (day < addDays(today, -60)) throw this.badDate('That date is too far back. Choose a date from the last 60 days or later');
            if (day > addDays(today, 365)) throw this.badDate('That date is more than a year away');
        }
        return day;
    }

    private badDate(message: string) {
        return new BadRequestException({ code: 'STAGE_DATE_INVALID', message, fields: { date: message } });
    }

    /**
     * Moves the open opportunity to a stage, forwards or back. Test, Psychometric session and Closed Won each need a
     * day (when the test is scheduled, when the session is, when it was won). Choosing the stage the lead is already at
     * with a new day reschedules it. Closed Won ends it as won and makes the lead Enrolled, so it is for closers and
     * managers, not BDAs.
     */
    async moveStage(auth: AuthContext, leadPublicId: string, to: OpportunityStageName, date: string | null = null) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        const open = await this.openFor(lead.id);
        const actorId = await this.actorId(auth);
        if (open.stage === to) {
            if (date !== null && (to === 'TEST' || to === 'PSYCHOMETRIC_SESSION')) {
                const on = this.checkDay(to, date);
                if (!(await this.repository.reschedule(open.id, to, on))) this.changed();
                await this.timeline.append({
                    leadId: lead.id,
                    type: TimelineEvent.OpportunityStageChanged,
                    actorType: 'USER',
                    actorId,
                    data: { from: to, to, on, rescheduled: true },
                });
            }
            return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
        }

        if (to === 'CLOSED_WON' && auth.role === 'BDA') {
            throw new ForbiddenException({
                code: 'CLOSE_NOT_ALLOWED',
                message: 'Only a closer or sales manager can close a lead as won',
            });
        }
        const on = isDatedStage(to) ? this.checkDay(to, date) : null;
        if (to === 'CLOSED_WON') {
            if (!(await this.repository.markWon(open.id, open.stage, actorId, on!))) this.changed();
            await this.timeline.append({
                leadId: lead.id,
                type: TimelineEvent.OpportunityWon,
                actorType: 'USER',
                actorId,
                data: { stage: open.stage, on },
            });
            await this.leads.markEnrolled(lead.id, actorId);
        } else {
            if (!(await this.repository.moveStage(open.id, open.stage, to, actorId, on))) this.changed();
            await this.timeline.append({
                leadId: lead.id,
                type: TimelineEvent.OpportunityStageChanged,
                actorType: 'USER',
                actorId,
                data: { from: open.stage, to, ...(on ? { on } : {}) },
            });
        }
        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }

    /**
     * Closes the open opportunity as won and records the payment: the fee agreed, how they pay and what has been
     * collected. One step, so no win is ever left without its numbers. Closers, managers and admins only.
     */
    async markWon(auth: AuthContext, leadPublicId: string, body: MarkWonBody, meta: { ip?: string | null } = {}) {
        if (auth.role === 'BDA') {
            throw new ForbiddenException({ code: 'CLOSE_NOT_ALLOWED', message: 'Only a closer or sales manager can close a lead as won' });
        }
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        const open = await this.openFor(lead.id);
        const actorId = await this.actorId(auth);
        const { wonOn, ...payment } = body;
        const on = this.checkDay('CLOSED_WON', wonOn);
        if (!(await this.repository.markWonWithEnrolment(open.id, open.stage, actorId, payment, on))) this.changed();
        await this.timeline.append({
            leadId: lead.id,
            type: TimelineEvent.OpportunityWon,
            actorType: 'USER',
            actorId,
            data: { stage: open.stage, paymentMode: body.paymentMode, on },
        });
        await this.leads.markEnrolled(lead.id, actorId);
        await this.admin.audit({
            action: AuditAction.LeadWonRecorded,
            actorId,
            entityType: 'lead',
            entityId: leadPublicId,
            detail: { fee: body.feeAmount, collected: body.amountCollected, mode: body.paymentMode, wonOn: on },
            ip: meta.ip ?? null,
        });
        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }

    /**
     * Records or corrects the payment of the lead's latest won deal: as instalments come in, or for a deal closed
     * before payments were recorded. Managers and admins (a closer no longer sees a lead once it is won).
     */
    async saveEnrolment(auth: AuthContext, leadPublicId: string, body: EnrolmentBody, meta: { ip?: string | null } = {}) {
        if (auth.role === 'BDA') {
            throw new ForbiddenException({ code: 'ENROLMENT_NOT_ALLOWED', message: 'Only a closer or sales manager can record payments' });
        }
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        const won = await this.repository.findLatestWon(lead.id);
        if (!won) throw new ConflictException({ code: 'NOT_WON', message: 'This lead has no won deal to record a payment for' });
        const actorId = await this.actorId(auth);
        await this.repository.saveEnrolment(won.id, body, actorId);
        await this.admin.audit({
            action: AuditAction.EnrolmentUpdated,
            actorId,
            entityType: 'lead',
            entityId: leadPublicId,
            detail: { fee: body.feeAmount, collected: body.amountCollected, mode: body.paymentMode, first: won.enrolment === null },
            ip: meta.ip ?? null,
        });
        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }

    /** Closes the open opportunity as lost, with one of the configured reasons. */
    async markLost(auth: AuthContext, leadPublicId: string, reasonId: number, note: string | null) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        const reason = await this.repository.findLostReason(reasonId);
        if (!reason) {
            throw new BadRequestException({ code: 'LOST_REASON_INVALID', message: 'Choose one of the listed reasons' });
        }
        const open = await this.openFor(lead.id);
        if (!(await this.repository.markLost(open.id, open.stage, reason.id, note))) this.changed();
        const actorId = await this.actorId(auth);
        await this.timeline.append({
            leadId: lead.id,
            type: TimelineEvent.OpportunityLost,
            actorType: 'USER',
            actorId,
            data: { stage: open.stage, reason: reason.name, hasNote: note !== null },
        });
        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }

    /** Starts a new opportunity at the first stage for a lead whose last one was lost. */
    async reopen(auth: AuthContext, leadPublicId: string) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        if (lead.lifecycleStage === 'ENROLLED' || lead.lifecycleStage === 'LEARNER_ONBOARDED') {
            throw new ConflictException({ code: 'ALREADY_ENROLLED', message: 'This lead is already enrolled' });
        }
        const actorId = await this.actorId(auth);
        const opened = await this.openOpportunity({ leadId: lead.id, ownerId: lead.ownerId, actorId });
        if (!opened.created) {
            throw new ConflictException({ code: 'ALREADY_OPEN', message: 'This lead already has an open opportunity' });
        }
        await this.timeline.append({
            leadId: lead.id,
            type: TimelineEvent.OpportunityOpened,
            actorType: 'USER',
            actorId,
            data: { stage: FIRST_STAGE, reopened: true },
        });
        return this.leads.getLead(auth, leadPublicId, { afterMarking: true });
    }
}
