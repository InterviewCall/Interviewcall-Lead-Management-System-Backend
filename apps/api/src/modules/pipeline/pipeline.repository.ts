import { Injectable } from '@nestjs/common';
import { isUniqueViolation, ModelService } from '@app/model';
import type {
    EnrolmentInput,
    LostReasonAdminView,
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

    /**
     * A merge: the duplicate's opportunities move to the kept lead. A lead can have only one open opportunity, so
     * when both are open the one further along stays open and the other is closed as MERGED (not lost: nobody lost
     * the deal). Safe to repeat.
     */
    absorbOpportunities(keepId: bigint, dropId: bigint): Promise<void> {
        const order = ['CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_2', 'PSYCHOMETRIC_SESSION', 'DECISION_OBJECTION', 'PAYMENT_FINANCING', 'CLOSED_WON'];
        return this.db.$transaction(async (tx) => {
            const kept = await tx.opportunity.findFirst({ where: { leadId: keepId, status: 'OPEN' }, select: { id: true, stage: true } });
            const moving = await tx.opportunity.findFirst({ where: { leadId: dropId, status: 'OPEN' }, select: { id: true, stage: true } });
            const now = new Date();
            if (kept && moving) {
                const keepMoving = order.indexOf(moving.stage) > order.indexOf(kept.stage);
                const closing = keepMoving ? kept : moving;
                await tx.opportunity.update({ where: { id: closing.id }, data: { status: 'MERGED', openLeadId: null, closedAt: now } });
                if (keepMoving) await tx.opportunity.update({ where: { id: moving.id }, data: { leadId: keepId, openLeadId: keepId } });
            } else if (moving) {
                await tx.opportunity.update({ where: { id: moving.id }, data: { leadId: keepId, openLeadId: keepId } });
            }
            await tx.opportunity.updateMany({ where: { leadId: dropId, status: { not: 'OPEN' } }, data: { leadId: keepId } });
            // A MERGED one closed above may still sit on the duplicate.
            await tx.opportunity.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
        });
    }

    /** Closes an open opportunity as won and records what was agreed, in one transaction. */
    markWonWithEnrolment(opportunityId: bigint, from: OpportunityStageName, actorId: bigint | null, enrolment: EnrolmentInput): Promise<boolean> {
        return this.db.$transaction(async (tx) => {
            const now = new Date();
            const { count } = await tx.opportunity.updateMany({
                where: { id: opportunityId, status: 'OPEN', stage: from },
                data: { stage: 'CLOSED_WON', status: 'WON', openLeadId: null, closedAt: now, stageChangedAt: now },
            });
            if (count !== 1) return false;
            await tx.opportunityStageChange.create({ data: { opportunityId, fromStage: from, toStage: 'CLOSED_WON', changedById: actorId } });
            await tx.enrolment.create({ data: { opportunityId, ...enrolment, recordedById: actorId } });
            return true;
        });
    }

    /** The lead's latest won opportunity, with whether its payment is recorded. */
    findLatestWon(leadId: bigint) {
        return this.db.opportunity.findFirst({
            where: { leadId, status: 'WON' },
            orderBy: { closedAt: 'desc' },
            select: { id: true, enrolment: { select: { id: true } } },
        });
    }

    /** Records or replaces the payment details of a won opportunity. */
    async saveEnrolment(opportunityId: bigint, enrolment: EnrolmentInput, actorId: bigint | null): Promise<void> {
        await this.db.enrolment.upsert({
            where: { opportunityId },
            create: { opportunityId, ...enrolment, recordedById: actorId },
            update: { ...enrolment, recordedById: actorId },
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

    /** Erasure: the free-text notes on the lead's opportunities and payments. Stages, reasons and amounts stay. */
    async eraseLeadNotes(leadId: bigint): Promise<void> {
        await this.db.$transaction([
            this.db.opportunity.updateMany({ where: { leadId }, data: { lostNote: null } }),
            this.db.enrolment.updateMany({ where: { opportunity: { leadId } }, data: { note: null } }),
        ]);
    }

    listLostReasons(): Promise<LostReasonView[]> {
        return this.db.lostReason.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true },
        });
    }

    async listLostReasonsForAdmin(): Promise<LostReasonAdminView[]> {
        const rows = await this.db.lostReason.findMany({
            orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true, isActive: true, sortOrder: true, _count: { select: { opportunities: true } } },
        });
        return rows.map(({ _count, ...r }) => ({ ...r, used: _count.opportunities }));
    }

    findLostReasonAnyState(id: number) {
        return this.db.lostReason.findUnique({ where: { id }, select: { id: true, name: true, isActive: true, sortOrder: true } });
    }

    findLostReasonNameTaken(name: string, exceptId?: number) {
        return this.db.lostReason.findFirst({ where: { name, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    }

    async nextLostReasonOrder(): Promise<number> {
        const top = await this.db.lostReason.aggregate({ _max: { sortOrder: true } });
        return (top._max.sortOrder ?? -1) + 1;
    }

    async createLostReason(name: string, sortOrder: number): Promise<number> {
        return (await this.db.lostReason.create({ data: { name, sortOrder }, select: { id: true } })).id;
    }

    async updateLostReason(id: number, data: { name?: string; isActive?: boolean; sortOrder?: number }): Promise<void> {
        await this.db.lostReason.update({ where: { id }, data });
    }

    /** How many active outcomes close the lead as lost with this reason (they find it by name). */
    outcomesUsingLostReason(name: string): Promise<number> {
        return this.db.outcome.count({ where: { isActive: true, effect: { path: '$.lostReason', equals: name } } });
    }

    findLostReason(id: number): Promise<LostReasonView | null> {
        return this.db.lostReason.findFirst({ where: { id, isActive: true }, select: { id: true, name: true } });
    }

    findLostReasonByName(name: string): Promise<LostReasonView | null> {
        return this.db.lostReason.findFirst({ where: { name, isActive: true }, select: { id: true, name: true } });
    }

    /** Notes the time of the booked call on the lead's open opportunity (null clears it). */
    async setScheduledCall(leadId: bigint, at: Date | null): Promise<boolean> {
        const { count } = await this.db.opportunity.updateMany({
            where: { leadId, status: 'OPEN' },
            data: { scheduledCallAt: at },
        });
        return count > 0;
    }

    /** The open opportunities of these leads now belong to `ownerId`, as the leads do. */
    async reassignOpen(leadIds: bigint[], ownerId: bigint): Promise<void> {
        for (let i = 0; i < leadIds.length; i += 500) {
            await this.db.opportunity.updateMany({
                where: { leadId: { in: leadIds.slice(i, i + 500) }, status: 'OPEN' },
                data: { ownerId },
            });
        }
    }
}
