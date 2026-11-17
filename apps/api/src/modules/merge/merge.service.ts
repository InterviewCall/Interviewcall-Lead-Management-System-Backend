import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { AssignmentService } from '@modules/assignment';
import { EngagementService } from '@modules/engagement';
import { IamService } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';

const MERGERS: readonly string[] = ['ADMIN', 'SALES_MANAGER'];

/**
 * Merging two leads that are the same person: everything the duplicate holds (contact details, history, calls,
 * follow-ups, VSL forms and bookings, opportunities, lists, score) moves to the lead that is kept, and the duplicate
 * becomes a pointer to it. Each module moves its own records; the lead itself is marked merged last, so a merge cut
 * short can simply be run again. Managers and admins only.
 */
@Injectable()
export class MergeService {
    constructor(
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly engagement: EngagementService,
        private readonly assignment: AssignmentService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    async merge(auth: AuthContext, keepPublicId: string, dropPublicId: string, meta: { ip?: string | null } = {}) {
        if (!MERGERS.includes(auth.role)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only a sales manager or admin can merge leads' });
        if (keepPublicId === dropPublicId) {
            throw new BadRequestException({ code: 'SAME_LEAD', message: 'Choose a different lead to merge', fields: { duplicateId: 'Choose a different lead' } });
        }
        const [keep, drop] = await Promise.all([this.leads.findMergeCandidate(keepPublicId), this.leads.findMergeCandidate(dropPublicId)]);
        if (!keep || keep.anonymisedAt) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'This lead does not exist' });
        if (!drop || drop.anonymisedAt) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'The duplicate does not exist' });
        if (keep.mergedIntoId !== null) throw new ConflictException({ code: 'LEAD_MERGED', message: 'This lead was already merged into another one. Open that one instead' });
        // Already done: answer as if it had just happened.
        if (drop.mergedIntoId === keep.id) return this.leads.getLead(auth, keepPublicId, { afterMarking: true });
        if (drop.mergedIntoId !== null) throw new ConflictException({ code: 'LEAD_MERGED', message: 'The duplicate was already merged into another lead' });

        const actor = await this.iam.getStaffRef(auth.publicId);
        const actorId = actor?.id ?? null;
        await this.pipeline.absorbOpportunities(keep.id, drop.id);
        await this.engagement.moveLeadRecords(drop.id, keep.id);
        await this.timeline.moveEvents(drop.id, keep.id);
        await this.assignment.moveLogOf(drop.id, keep.id);
        const { ownerId } = await this.leads.absorbLead(keep.id, drop.id);
        // Whatever was open on either lead is worked by the kept lead's owner.
        if (ownerId !== null) {
            await this.pipeline.reassignOpenOpportunities([keep.id], ownerId);
            await this.engagement.reassignOpenTasks([keep.id], ownerId);
        }
        await this.timeline.append({ leadId: keep.id, type: TimelineEvent.LeadsMerged, actorType: 'USER', actorId, data: { merged: drop.publicId } });
        await this.admin.audit({
            action: AuditAction.LeadsMerged,
            actorId,
            entityType: 'lead',
            entityId: keep.publicId,
            detail: { merged: drop.publicId },
            ip: meta.ip ?? null,
        });
        return this.leads.getLead(auth, keepPublicId, { afterMarking: true });
    }
}
