import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { EngagementService } from '@modules/engagement';
import { IamService } from '@modules/iam';
import { ImportsService } from '@modules/imports';
import { IntakeService } from '@modules/intake';
import { LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';

/**
 * Erasing one person's details when they ask (the DPDP right to erasure). The lead stays as a row with no name,
 * phone, email or notes, so the counts, stages and revenue in the reports still add up. Each module erases what it
 * holds; the lead itself is wiped last, so a run cut short is simply run again. Admins only.
 *
 * If the lead was marked do not contact, the flag stays, but with the phone and email gone it can no longer match
 * anything: the same person who contacts you again arrives as a new lead.
 */
@Injectable()
export class PrivacyService {
    constructor(
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly engagement: EngagementService,
        private readonly intake: IntakeService,
        private readonly imports: ImportsService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    async anonymise(auth: AuthContext, publicId: string, reason: string, meta: { ip?: string | null } = {}) {
        const lead = await this.leads.findMergeCandidate(publicId);
        if (!lead) throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'This lead does not exist' });
        if (lead.anonymisedAt) throw new ConflictException({ code: 'ALREADY_ANONYMISED', message: 'This lead was already anonymised' });

        await this.engagement.eraseLeadRecords(lead.id);
        await this.pipeline.eraseLeadNotes(lead.id);
        await this.intake.erasePayloads(lead.id);
        await this.imports.eraseRows(lead.id);
        await this.timeline.clearEventData(lead.id);
        await this.leads.eraseLead(lead.id);

        const actor = await this.iam.getStaffRef(auth.publicId);
        await this.timeline.append({ leadId: lead.id, type: TimelineEvent.Anonymised, actorType: 'USER', actorId: actor?.id ?? null, data: {} });
        // The reason is kept in the audit log, which holds no personal details of the lead.
        await this.admin.audit({
            action: AuditAction.LeadAnonymised,
            actorId: actor?.id ?? null,
            entityType: 'lead',
            entityId: publicId,
            detail: { reason },
            ip: meta.ip ?? null,
        });
        // The lead no longer opens (anonymised leads are out of every list and search), so there is no page to return.
        return { id: publicId, anonymised: true as const };
    }
}
