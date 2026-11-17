import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { AssignmentService } from '@modules/assignment';
import { IamService, type StaffRef } from '@modules/iam';
import { type CreateLeadBody, LeadsService, normaliseMobile } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';

const FIRST_STAGE = 'CALL_1_PENDING';

/**
 * A lead added by hand: a referral, a walk-in, an inbound call or WhatsApp. It goes through the same matching
 * as every other source, so a person already in the CRM is never added twice: the answer then says who they
 * are and who owns them. A new lead starts like any other: Marketing Lead, an opportunity at Call 1 Pending.
 */
@Injectable()
export class CaptureService {
    constructor(
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly assignment: AssignmentService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    async create(auth: AuthContext, body: CreateLeadBody, meta: { ip?: string | null } = {}): Promise<{ id: string }> {
        const phone = body.phone === null ? null : normaliseMobile(body.phone);
        if (body.phone !== null && phone === null) throw this.badField('phone', 'Enter a 10-digit Indian mobile number');
        if (phone === null && body.email === null) throw this.badField('phone', 'Enter a phone number or an email');

        const source = await this.leads.findActiveSource(body.sourceId);
        if (!source) throw this.badField('sourceId', 'Choose one of the listed sources');

        const actor = await this.iam.getStaffRef(auth.publicId);
        if (!actor) throw new BadRequestException({ code: 'STAFF_NOT_FOUND', message: 'Your account could not be found' });
        // A BDA works what they bring in; a manager or admin chooses, or leaves it for the Assignment queue.
        let owner: StaffRef | null;
        if (auth.role === 'BDA') owner = actor;
        else owner = body.ownerId === null ? null : await this.assignment.assigneeFor(auth, body.ownerId);

        const ref = `manual:${randomUUID()}`;
        const outcome = await this.leads.importLead({
            fields: {
                fullName: body.fullName,
                email: body.email,
                phoneE164: phone?.phoneE164 ?? null,
                phoneLast10: phone?.phoneLast10 ?? null,
                currentCompany: body.currentCompany,
                currentCtc: body.currentCtc,
                graduationYear: body.graduationYear,
                domain: body.domain,
                userType: 'UNKNOWN',
                custom: {},
            },
            sourceId: source.id,
            ownerId: owner?.id ?? null,
            listId: null,
            ref,
            // Someone already here is not touched: the person adding them is told instead.
            handling: 'SKIP',
            initialScore: 0,
            kind: 'MANUAL',
            touchpointPayload: { addedBy: auth.publicId },
        });

        if (outcome.kind !== 'CREATED') {
            const existingId = outcome.kind === 'MATCHED' ? outcome.match.leadId : outcome.first.leadId;
            const existing = await this.leads.describeExisting(auth, existingId);
            const message =
                outcome.kind === 'CONFLICT'
                    ? 'The email and the phone belong to two different leads already'
                    : `This person is already a lead${existing.owner ? `, owned by ${existing.owner.name}` : ', not assigned yet'}`;
            throw new ConflictException({ code: 'LEAD_EXISTS', message, existing });
        }

        const leadId = outcome.leadId;
        const opportunity = await this.pipeline.openOpportunity({ leadId, ownerId: owner?.id ?? null, actorId: actor.id });
        if (owner) await this.assignment.recordManualAssignment({ leadId, toUserId: owner.id, byUserId: actor.id, sourceId: source.id });
        await this.timeline.appendMany([
            { leadId, type: TimelineEvent.LeadCreated, actorType: 'USER', actorId: actor.id, data: { via: 'MANUAL', sourceId: source.id } },
            ...(owner
                ? [{ leadId, type: TimelineEvent.Assigned, actorType: 'USER' as const, actorId: actor.id, data: { to: owner.publicId, method: 'MANUAL' } }]
                : []),
            { leadId, type: TimelineEvent.OpportunityOpened, actorType: 'USER', actorId: actor.id, data: { stage: FIRST_STAGE, opportunity: opportunity.publicId } },
        ]);

        const created = (await this.leads.leadNames([leadId])).get(leadId)!;
        await this.admin.audit({
            action: AuditAction.LeadCreated,
            actorId: actor.id,
            entityType: 'lead',
            entityId: created.publicId,
            detail: { source: source.id, owner: owner?.publicId ?? null },
            ip: meta.ip ?? null,
        });
        return { id: created.publicId };
    }

    private badField(field: string, message: string) {
        return new BadRequestException({ code: 'VALIDATION_FAILED', message, fields: { [field]: message } });
    }
}
