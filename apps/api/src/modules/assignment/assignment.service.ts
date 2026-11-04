import { randomUUID } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { IamService, type StaffRef } from '@modules/iam';
import { type AssignableLead, LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { AssignmentRepository } from './assignment.repository.js';
import type {
    AssigneeView,
    BatchView,
    ImportAssignmentInput,
    MoveResult,
    SystemAssignmentInput,
} from './assignment.types.js';

/** Who may give leads to other people. */
const DISTRIBUTORS: readonly string[] = ['ADMIN', 'SALES_MANAGER'];
/** Who may be given leads. */
const ASSIGNEE_ROLES = ['ADMIN', 'SALES_MANAGER', 'BDA'] as const;

/** Lists the system makes for each day's WorkR signups have this origin ref prefix. */
export const WORKR_BATCH_PREFIX = 'workr-day:';

@Injectable()
export class AssignmentService {
    constructor(
        private readonly repository: AssignmentRepository,
        private readonly leads: LeadsService,
        private readonly iam: IamService,
        private readonly pipeline: PipelineService,
        private readonly timeline: TimelineService,
        private readonly admin: AdminService,
    ) {}

    /**
     * Writes the assignment log line for a lead an import gave to someone. With `mayExist` it first
     * checks that this import has not already written it (a retried row); a brand-new lead cannot
     * have one, so the importer skips the check.
     */
    async recordImportAssignment(
        input: ImportAssignmentInput,
        options: { mayExist: boolean } = { mayExist: true },
    ): Promise<void> {
        if (options.mayExist && (await this.repository.hasBatchEntry(input.leadId, input.batchId))) {
            return;
        }
        await this.repository.insertImportEntry(input);
    }

    /** The log line for a lead the system gave to someone (an intake lead going to the intake owner). */
    async recordSystemAssignment(
        input: SystemAssignmentInput,
        options: { mayExist: boolean } = { mayExist: true },
    ): Promise<void> {
        if (options.mayExist && (await this.repository.hasBatchEntry(input.leadId, input.batchId))) {
            return;
        }
        await this.repository.insertSystemEntry(input);
    }

    private assertDistributor(auth: AuthContext): void {
        if (!DISTRIBUTORS.includes(auth.role)) {
            throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have access to this' });
        }
    }

    /** People leads can be given to. */
    async assignees(auth: AuthContext): Promise<{ assignees: AssigneeView[] }> {
        this.assertDistributor(auth);
        const staff = await this.iam.listActiveStaff([...ASSIGNEE_ROLES]);
        return { assignees: staff.map((s) => ({ id: s.publicId, name: s.name, role: s.role })) };
    }

    /** Recent daily WorkR lists and how many of their leads still wait with the intake owner. */
    async batches(auth: AuthContext): Promise<{ batches: BatchView[] }> {
        this.assertDistributor(auth);
        const rows = await this.leads.listBatches(WORKR_BATCH_PREFIX, 30);
        const names = await this.iam.getStaffNames([...new Set(rows.map((r) => r.ownerId))]);
        return {
            batches: rows.map((row) => ({
                id: row.publicId,
                name: row.name,
                createdAt: row.createdAt.toISOString(),
                total: row.total,
                waiting: row.waiting,
                ownerName: names.get(row.ownerId) ?? 'The intake owner',
            })),
        };
    }

    private async targetOf(publicId: string): Promise<StaffRef> {
        const target = await this.iam.getStaffRef(publicId);
        if (!target || !target.isActive || !(ASSIGNEE_ROLES as readonly string[]).includes(target.role)) {
            throw new BadRequestException({
                code: 'ASSIGNEE_INVALID',
                message: 'Choose an active admin, sales manager or BDA',
                fields: { toUserId: 'Choose an active admin, sales manager or BDA' },
            });
        }
        return target;
    }

    /**
     * Gives every lead of a daily list that still waits with the intake owner to one person, in
     * one step. Safe to repeat: leads already handed over are no longer waiting, so a second
     * press moves only what arrived since.
     */
    async handOver(
        auth: AuthContext,
        input: { listId: string; toUserId: string },
        meta: { ip?: string | null } = {},
    ): Promise<MoveResult> {
        this.assertDistributor(auth);
        const list = await this.leads.findListByPublicId(input.listId);
        if (!list || !list.originRef?.startsWith(WORKR_BATCH_PREFIX)) {
            throw new NotFoundException({ code: 'LIST_NOT_FOUND', message: 'That list no longer exists' });
        }
        const target = await this.targetOf(input.toUserId);
        const waiting = await this.leads.findListLeadsOwnedBy(list.id, list.createdById);
        if (waiting.length === 0) {
            throw new ConflictException({
                code: 'NOTHING_TO_HAND_OVER',
                message: 'Every lead in this list has already been handed over',
            });
        }
        if (target.id === list.createdById) {
            throw new ConflictException({
                code: 'SAME_OWNER',
                message: `These leads already belong to ${target.name}`,
            });
        }
        return this.move(auth, waiting, target, {
            method: 'BULK',
            reasonCode: 'HANDOVER',
            audit: AuditAction.LeadsHandedOver,
            entity: { type: 'lead_list', id: list.publicId },
            ip: meta.ip ?? null,
        });
    }

    /** Gives the chosen leads to one person, whoever has them now. */
    async bulkAssign(
        auth: AuthContext,
        input: { leadIds: string[]; toUserId: string },
        meta: { ip?: string | null } = {},
    ): Promise<MoveResult> {
        this.assertDistributor(auth);
        const target = await this.targetOf(input.toUserId);
        const found = await this.leads.findAssignableByPublicIds([...new Set(input.leadIds)]);
        const result = await this.move(auth, found, target, {
            method: 'BULK',
            reasonCode: 'BULK_ASSIGN',
            audit: AuditAction.LeadsBulkAssigned,
            entity: { type: 'leads', id: null },
            ip: meta.ip ?? null,
        });
        // Leads that were not found count as skipped too.
        return { ...result, skipped: result.skipped + (new Set(input.leadIds).size - found.length) };
    }

    private async move(
        auth: AuthContext,
        leads: AssignableLead[],
        target: StaffRef,
        how: {
            method: 'BULK';
            reasonCode: string;
            audit: typeof AuditAction.LeadsHandedOver | typeof AuditAction.LeadsBulkAssigned;
            entity: { type: string; id: string | null };
            ip: string | null;
        },
    ): Promise<MoveResult> {
        const actor = await this.iam.getStaffRef(auth.publicId);
        const actorId = actor?.id ?? null;
        const candidates = leads.filter((lead) => lead.ownerId !== target.id);
        const movedIds = new Set(
            await this.leads.reassignOwner(
                candidates.map((lead) => ({ id: lead.id, fromOwnerId: lead.ownerId })),
                target.id,
            ),
        );
        const moved = candidates.filter((lead) => movedIds.has(lead.id));

        if (moved.length > 0) {
            await this.pipeline.reassignOpenOpportunities(moved.map((lead) => lead.id), target.id);
            const batchId = randomUUID();
            await this.repository.insertMany(
                moved.map((lead) => ({
                    leadId: lead.id,
                    fromUserId: lead.ownerId,
                    toUserId: target.id,
                    byUserId: actorId,
                    method: how.method,
                    reasonCode: how.reasonCode,
                    batchId,
                    sourceId: lead.firstSourceId,
                    vslDepth: lead.vslDepth,
                    temperature: lead.temperature,
                })),
            );
            await this.timeline.appendMany(
                moved.map((lead) => ({
                    leadId: lead.id,
                    type: TimelineEvent.Assigned,
                    actorType: 'USER' as const,
                    actorId,
                    data: { to: target.publicId, method: how.method },
                })),
            );
            await this.admin.audit({
                action: how.audit,
                actorId,
                entityType: how.entity.type,
                entityId: how.entity.id,
                detail: { to: target.publicId, count: moved.length, batch: batchId },
                ip: how.ip,
            });
        }
        return {
            moved: moved.length,
            skipped: leads.length - moved.length,
            to: { id: target.publicId, name: target.name },
        };
    }
}
