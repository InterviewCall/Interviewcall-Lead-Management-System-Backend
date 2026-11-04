import { Injectable } from '@nestjs/common';
import { isUniqueViolation, ModelService } from '@app/model';
import type {
    LostReasonView,
    OpenOpportunityInput,
    OpenedOpportunity,
    OpenOpportunityRef,
    OpportunityStageName,
} from './pipeline.types.js';

/**
 * The only class allowed to read or write this module's tables:
 * opportunities, opportunity_stage_changes, lost_reasons.
 * Other modules call PipelineService instead of touching these models.
 */
@Injectable()
export class PipelineRepository {
    constructor(private readonly db: ModelService) {}

    private findOpen(leadId: bigint) {
        return this.db.opportunity.findUnique({
            where: { openLeadId: leadId },
            select: { id: true, publicId: true },
        });
    }

    /**
     * Opens an opportunity with its first stage change. The unique index on open_lead_id means a
     * lead can have only one open opportunity, so asking twice returns the one that exists.
     */
    async open(input: OpenOpportunityInput & { stage: NonNullable<OpenOpportunityInput['stage']> }): Promise<OpenedOpportunity> {
        try {
            const created = await this.db.opportunity.create({
                data: {
                    leadId: input.leadId,
                    openLeadId: input.leadId,
                    stage: input.stage,
                    ownerId: input.ownerId,
                    stageChanges: {
                        create: {
                            fromStage: null,
                            toStage: input.stage,
                            changedById: input.actorId,
                        },
                    },
                },
                select: { id: true, publicId: true },
            });
            return { opportunityId: created.id, publicId: created.publicId, created: true };
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            const existing = await this.findOpen(input.leadId);
            if (!existing) throw error;
            return { opportunityId: existing.id, publicId: existing.publicId, created: false };
        }
    }

    /** The lead's open opportunity, if it has one. */
    async findOpenFor(leadId: bigint): Promise<OpenOpportunityRef | null> {
        const row = await this.db.opportunity.findUnique({
            where: { openLeadId: leadId },
            select: { id: true, publicId: true, stage: true },
        });
        return row as OpenOpportunityRef | null;
    }

    /**
     * Moves an open opportunity to another stage and records the change. False when it was not
     * open at `from` any more (someone else moved it first).
     */
    moveStage(
        opportunityId: bigint,
        from: OpportunityStageName,
        to: OpportunityStageName,
        actorId: bigint | null,
    ): Promise<boolean> {
        return this.db.$transaction(async (tx) => {
            const { count } = await tx.opportunity.updateMany({
                where: { id: opportunityId, status: 'OPEN', stage: from },
                data: { stage: to, stageChangedAt: new Date() },
            });
            if (count !== 1) return false;
            await tx.opportunityStageChange.create({
                data: { opportunityId, fromStage: from, toStage: to, changedById: actorId },
            });
            return true;
        });
    }

    /** Closes an open opportunity as won at Closed Won. */
    markWon(opportunityId: bigint, from: OpportunityStageName, actorId: bigint | null): Promise<boolean> {
        return this.db.$transaction(async (tx) => {
            const now = new Date();
            const { count } = await tx.opportunity.updateMany({
                where: { id: opportunityId, status: 'OPEN', stage: from },
                data: { stage: 'CLOSED_WON', status: 'WON', openLeadId: null, closedAt: now, stageChangedAt: now },
            });
            if (count !== 1) return false;
            await tx.opportunityStageChange.create({
                data: { opportunityId, fromStage: from, toStage: 'CLOSED_WON', changedById: actorId },
            });
            return true;
        });
    }

    /** Closes an open opportunity as lost. It keeps the stage it was lost at. */
    async markLost(
        opportunityId: bigint,
        from: OpportunityStageName,
        reasonId: number,
        note: string | null,
    ): Promise<boolean> {
        const { count } = await this.db.opportunity.updateMany({
            where: { id: opportunityId, status: 'OPEN', stage: from },
            data: { status: 'LOST', openLeadId: null, lostReasonId: reasonId, lostNote: note, closedAt: new Date() },
        });
        return count === 1;
    }

    listLostReasons(): Promise<LostReasonView[]> {
        return this.db.lostReason.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true },
        });
    }

    findLostReason(id: number): Promise<LostReasonView | null> {
        return this.db.lostReason.findFirst({ where: { id, isActive: true }, select: { id: true, name: true } });
    }
}
