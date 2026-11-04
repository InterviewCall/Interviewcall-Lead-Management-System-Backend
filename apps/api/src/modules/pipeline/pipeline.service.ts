import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { IamService } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { PipelineRepository } from './pipeline.repository.js';
import {
    FIRST_STAGE,
    type LostReasonView,
    type OpenedOpportunity,
    type OpenOpportunityInput,
    type OpportunityStageName,
} from './pipeline.types.js';

@Injectable()
export class PipelineService {
    constructor(
        private readonly repository: PipelineRepository,
        private readonly leads: LeadsService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
    ) {}

    /**
     * Opens the lead's opportunity at the first stage (Call 1 Pending) unless it already has an
     * open one. Safe to repeat.
     */
    openOpportunity(input: OpenOpportunityInput): Promise<OpenedOpportunity> {
        return this.repository.open({ ...input, stage: input.stage ?? FIRST_STAGE });
    }

    /** Keeps each lead's open opportunity with the lead's owner after the lead changes hands. */
    reassignOpenOpportunities(leadIds: bigint[], ownerId: bigint): Promise<void> {
        return this.repository.reassignOpen(leadIds, ownerId);
    }

    /** A VSL booking: the call time shows on the lead's open opportunity. */
    setScheduledCall(leadId: bigint, at: Date | null): Promise<boolean> {
        return this.repository.setScheduledCall(leadId, at);
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
     * Moves the open opportunity to a stage, forwards or back. Closed Won ends it as won and makes
     * the lead Enrolled, so it is for closers and managers, not BDAs.
     */
    async moveStage(auth: AuthContext, leadPublicId: string, to: OpportunityStageName) {
        const lead = await this.leads.resolveForMarking(auth, leadPublicId);
        const open = await this.openFor(lead.id);
        if (open.stage === to) return this.leads.getLead(auth, leadPublicId, { afterMarking: true });

        const actorId = await this.actorId(auth);
        if (to === 'CLOSED_WON') {
            if (auth.role === 'BDA') {
                throw new ForbiddenException({
                    code: 'CLOSE_NOT_ALLOWED',
                    message: 'Only a closer or sales manager can close a lead as won',
                });
            }
            if (!(await this.repository.markWon(open.id, open.stage, actorId))) this.changed();
            await this.timeline.append({
                leadId: lead.id,
                type: TimelineEvent.OpportunityWon,
                actorType: 'USER',
                actorId,
                data: { stage: open.stage },
            });
            await this.leads.markEnrolled(lead.id, actorId);
        } else {
            if (!(await this.repository.moveStage(open.id, open.stage, to, actorId))) this.changed();
            await this.timeline.append({
                leadId: lead.id,
                type: TimelineEvent.OpportunityStageChanged,
                actorType: 'USER',
                actorId,
                data: { from: open.stage, to },
            });
        }
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
