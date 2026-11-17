import { randomUUID } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import type { AuthContext, Role } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { EngagementService, InboxService } from '@modules/engagement';
import { IamService, type StaffRef } from '@modules/iam';
import { type AssignableLead, LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { AssignmentRepository } from './assignment.repository.js';
import type { DistributeBody, LeaveBody, MoveFromPersonBody, QueueQuery } from './assignment.schemas.js';
import type {
    AssigneeView,
    BatchView,
    DistributeResult,
    HistoryView,
    ImportAssignmentInput,
    LoadsView,
    MoveResult,
    QueueView,
    SystemAssignmentInput,
} from './assignment.types.js';
import { istDateKey } from './ist.js';

/** Who may give leads to other people. */
const DISTRIBUTORS: readonly string[] = ['ADMIN', 'SALES_MANAGER'];
/** Who may be given leads, by who is giving them: an admin may give to anyone who works leads, a sales manager to other managers and BDAs but not to an admin. */
const ASSIGNEE_ROLES: Record<'ADMIN' | 'SALES_MANAGER', readonly Role[]> = {
    ADMIN: ['ADMIN', 'SALES_MANAGER', 'BDA'],
    SALES_MANAGER: ['SALES_MANAGER', 'BDA'],
};
const assigneeRolesFor = (auth: AuthContext): Role[] => [...(auth.role === 'ADMIN' ? ASSIGNEE_ROLES.ADMIN : ASSIGNEE_ROLES.SALES_MANAGER)];

/** Who the equal distribution can share leads between: the people who work leads day to day. Never an admin. */
const DISTRIBUTION_ROLES = ['SALES_MANAGER', 'BDA'] as const;
const HOT_WINDOW_MS = 7 * 86_400_000;
const HISTORY_SIZE = 30;
const DEPTH_ORDER = { BOOKED: 3, FORM: 2, DETAILS: 1, NONE: 0 } as const;
const TEMPERATURE_ORDER = { HOT: 3, WARM: 2, COLD: 1 } as const;

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
        private readonly engagement: EngagementService,
        private readonly inbox: InboxService,
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
        const staff = await this.iam.listActiveStaff(assigneeRolesFor(auth));
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

    // ---- the Assignment page ----

    /** The leads waiting for someone, best first, with the counts the tabs show. */
    async queue(auth: AuthContext, query: QueueQuery, now = new Date()): Promise<QueueView> {
        this.assertDistributor(auth);
        const rows = await this.leads.waitingQueue(
            {
                tab: query.tab,
                limit: query.limit,
                ...(query.sourceId !== undefined ? { sourceId: query.sourceId } : {}),
                ...(query.depth ? { depth: query.depth } : {}),
                ...(query.temperature ? { temperature: query.temperature } : {}),
                ...(query.wait ? { wait: query.wait } : {}),
            },
            now,
        );
        return {
            items: rows.items.map((lead) => ({
                id: lead.publicId,
                name: lead.fullName,
                email: lead.email,
                company: lead.currentCompany,
                domain: lead.domain,
                depth: lead.vslDepth,
                temperature: lead.temperature,
                source: lead.firstSource.name,
                waitingHours: Math.max(0, Math.floor((now.getTime() - lead.capturedAt.getTime()) / 3_600_000)),
                bookedAt: lead.scheduledCallAt ? lead.scheduledCallAt.toISOString() : null,
            })),
            matchingIds: rows.matchingIds,
            total: rows.total,
            counts: rows.counts,
            sources: rows.sources,
        };
    }

    /** How many leads wait for someone (the sidebar pill). */
    async waiting(auth: AuthContext): Promise<{ waiting: number }> {
        this.assertDistributor(auth);
        return { waiting: await this.leads.countWaiting() };
    }

    /** The sales managers and BDAs, how much each holds, who is away, and where the round robin carries on from. */
    async loads(auth: AuthContext, now = new Date()): Promise<LoadsView> {
        this.assertDistributor(auth);
        const bdas = await this.iam.listActiveAssignees([...DISTRIBUTION_ROLES]);
        const ids = bdas.map((b) => b.id);
        const [open, hot, cursor] = await Promise.all([
            this.leads.ownerLoads(ids),
            this.repository.hotReceived(ids, new Date(now.getTime() - HOT_WINDOW_MS)),
            this.repository.cursorUserId(),
        ]);
        const openBy = new Map(open.map((o) => [o.ownerId, o.open]));
        const today = istDateKey(now);
        return {
            bdas: bdas.map((b) => ({
                id: b.publicId,
                name: b.name,
                role: b.role === 'SALES_MANAGER' ? 'SALES_MANAGER' : 'BDA',
                open: openBy.get(b.id) ?? 0,
                hotReceived: hot.get(b.id) ?? 0,
                leaveUntil: b.leaveUntil !== null && b.leaveUntil >= today ? b.leaveUntil : null,
            })),
            cursorUserId: bdas.find((b) => b.id === cursor)?.publicId ?? null,
        };
    }

    /** Sets the last day a person is away (or clears it). While away they are left out of the round robin. */
    async setLeave(auth: AuthContext, input: LeaveBody, meta: { ip?: string | null } = {}, now = new Date()): Promise<{ ok: true }> {
        this.assertDistributor(auth);
        const target = await this.iam.getStaffRef(input.userId);
        if (!target || !target.isActive || !(DISTRIBUTION_ROLES as readonly string[]).includes(target.role)) {
            throw new BadRequestException({ code: 'ASSIGNEE_INVALID', message: 'Choose an active BDA or sales manager', fields: { userId: 'Choose an active BDA or sales manager' } });
        }
        if (input.until !== null && input.until < istDateKey(now)) {
            throw new BadRequestException({ code: 'LEAVE_IN_PAST', message: 'The last day of leave cannot be in the past', fields: { until: 'Choose today or a later day' } });
        }
        const actor = await this.iam.getStaffRef(auth.publicId);
        await this.iam.setLeaveUntil(target.id, input.until);
        await this.admin.audit({
            action: AuditAction.LeaveSet,
            actorId: actor?.id ?? null,
            entityType: 'staff',
            entityId: target.publicId,
            detail: { until: input.until },
            ip: meta.ip ?? null,
        });
        return { ok: true };
    }

    /** Recent manual and equal distributions: when, by whom, how many, to whom. */
    async history(auth: AuthContext): Promise<{ history: HistoryView[] }> {
        this.assertDistributor(auth);
        const rows = await this.repository.recentBatches(HISTORY_SIZE);
        const names = await this.iam.getStaffNames([...new Set(rows.flatMap((r) => [...(r.byUserId === null ? [] : [r.byUserId]), ...r.toUserIds]))]);
        return {
            history: rows.map((r) => ({
                id: r.batchId,
                at: r.at.toISOString(),
                by: r.byUserId === null ? 'The system' : (names.get(r.byUserId) ?? 'Someone'),
                count: r.count,
                method: r.method,
                people: r.toUserIds.map((id) => names.get(id) ?? 'Someone'),
            })),
        };
    }

    /**
     * Shares waiting leads between the chosen BDAs and sales managers one after another, booked calls and hot leads first, carrying on
     * from the person after the one who got the last lead of the previous distribution, so over time everyone gets
     * the same. Leads somebody already owns are left alone. People on leave are refused.
     */
    async distribute(
        auth: AuthContext,
        input: DistributeBody,
        meta: { ip?: string | null } = {},
        now = new Date(),
    ): Promise<DistributeResult> {
        this.assertDistributor(auth);
        const roster = new Map((await this.iam.listActiveAssignees([...DISTRIBUTION_ROLES])).map((b) => [b.publicId, b]));
        const today = istDateKey(now);
        const people = [...new Set(input.toUserIds)].map((id) => {
            const person = roster.get(id);
            if (!person) {
                throw new BadRequestException({ code: 'ASSIGNEE_INVALID', message: 'Choose active BDAs or sales managers', fields: { toUserIds: 'Choose active BDAs or sales managers' } });
            }
            if (person.leaveUntil !== null && person.leaveUntil >= today) {
                throw new BadRequestException({
                    code: 'ASSIGNEE_ON_LEAVE',
                    message: `${person.name} is on leave until ${person.leaveUntil}`,
                    fields: { toUserIds: `${person.name} is on leave` },
                });
            }
            return person;
        });

        const found = await this.leads.findAssignableByPublicIds([...new Set(input.leadIds)]);
        const eligible = found
            .filter((lead) => lead.ownerId === null)
            .sort(
                (a, b) =>
                    DEPTH_ORDER[b.vslDepth] - DEPTH_ORDER[a.vslDepth] ||
                    (b.temperature ? TEMPERATURE_ORDER[b.temperature] : 0) - (a.temperature ? TEMPERATURE_ORDER[a.temperature] : 0),
            );
        const skippedAtStart = new Set(input.leadIds).size - eligible.length;
        if (eligible.length === 0) {
            return { assigned: 0, skipped: skippedAtStart, perPerson: [] };
        }

        const cursor = await this.repository.cursorUserId();
        const after = people.findIndex((p) => p.id === cursor);
        const start = after === -1 ? 0 : (after + 1) % people.length;
        const groups = new Map<bigint, AssignableLead[]>();
        eligible.forEach((lead, i) => {
            const person = people[(start + i) % people.length]!;
            groups.set(person.id, [...(groups.get(person.id) ?? []), lead]);
        });

        const batchId = randomUUID();
        let assigned = 0;
        let skipped = skippedAtStart;
        const perPerson: DistributeResult['perPerson'] = [];
        let lastGiven: bigint | null = null;
        for (let i = 0; i < eligible.length; i++) {
            // Walk the order the round robin handed leads out, so the cursor ends on the right person.
            const person = people[(start + i) % people.length]!;
            const group = groups.get(person.id);
            if (!group) continue;
            groups.delete(person.id);
            const result = await this.move(auth, group, person, {
                method: 'EQUAL_DISTRIBUTION',
                reasonCode: 'EQUAL_DISTRIBUTION',
                audit: AuditAction.LeadsDistributed,
                entity: { type: 'leads', id: null },
                ip: meta.ip ?? null,
                batchId,
            });
            assigned += result.moved;
            skipped += result.skipped;
            if (result.moved > 0) perPerson.push({ id: person.publicId, name: person.name, count: result.moved });
        }
        // The cursor goes to whoever received the last lead in the round.
        lastGiven = people[(start + eligible.length - 1) % people.length]!.id;
        if (assigned > 0) await this.repository.setCursor(lastGiven);
        return { assigned, skipped, perPerson };
    }

    countLeadsGivenTo(userId: bigint, from: Date, to: Date): Promise<number> {
        return this.repository.countLeadsGivenTo(userId, from, to);
    }

    /** A merge: the duplicate's assignment history belongs to the kept lead. */
    moveLogOf(fromLeadId: bigint, toLeadId: bigint): Promise<void> {
        return this.repository.moveLog(fromLeadId, toLeadId);
    }

    /** The person a lead added by hand may be given to: anyone this person may assign leads to. */
    assigneeFor(auth: AuthContext, publicId: string): Promise<StaffRef> {
        return this.targetOf(auth, publicId);
    }

    /**
     * The log line for a lead someone added by hand and gave an owner (themselves included). The owner hears
     * about it unless they added it.
     */
    async recordManualAssignment(input: { leadId: bigint; toUserId: bigint; byUserId: bigint | null; sourceId: number }): Promise<void> {
        await this.repository.insertMany([
            {
                leadId: input.leadId,
                fromUserId: null,
                toUserId: input.toUserId,
                byUserId: input.byUserId,
                method: 'MANUAL',
                reasonCode: 'ADDED_BY_HAND',
                batchId: randomUUID(),
                sourceId: input.sourceId,
                vslDepth: 'NONE',
                temperature: null,
            },
        ]);
        if (input.toUserId !== input.byUserId) await this.inbox.assigned(input.toUserId, [input.leadId]);
    }

    /** How many leads would move if this person's leads were handed to someone else. */
    async ownedCount(auth: AuthContext, userId: string): Promise<{ count: number }> {
        this.assertDistributor(auth);
        const person = await this.iam.getStaffRef(userId);
        if (!person) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: 'This person does not exist' });
        return { count: await this.leads.countHandoverLeadsOwnedBy(person.id) };
    }

    /**
     * Hands every lead a person owns (anything not yet enrolled) to the chosen people, round robin, best leads
     * first, with their open opportunities, follow-ups and booked calls. For someone leaving the team, or going
     * on a long break. Does not move the equal-distribution cursor: this is not the daily queue.
     */
    async moveFromPerson(auth: AuthContext, input: MoveFromPersonBody, meta: { ip?: string | null } = {}): Promise<DistributeResult> {
        this.assertDistributor(auth);
        const from = await this.iam.getStaffRef(input.fromUserId);
        if (!from) throw new NotFoundException({ code: 'STAFF_NOT_FOUND', message: 'This person does not exist' });
        const roster = new Map((await this.iam.listActiveAssignees(assigneeRolesFor(auth))).map((p) => [p.publicId, p]));
        const today = istDateKey(new Date());
        const people = [...new Set(input.toUserIds)].map((id) => {
            const person = roster.get(id);
            if (!person || person.id === from.id) {
                throw new BadRequestException({
                    code: 'ASSIGNEE_INVALID',
                    message: 'Choose active people other than the one whose leads move',
                    fields: { toUserIds: 'Choose active people other than the one whose leads move' },
                });
            }
            if (person.leaveUntil !== null && person.leaveUntil >= today) {
                throw new BadRequestException({
                    code: 'ASSIGNEE_ON_LEAVE',
                    message: `${person.name} is on leave until ${person.leaveUntil}`,
                    fields: { toUserIds: `${person.name} is on leave` },
                });
            }
            return person;
        });

        const leads = await this.leads.findHandoverLeadsOwnedBy(from.id);
        if (leads.length === 0) return { assigned: 0, skipped: 0, perPerson: [] };
        const groups = new Map<bigint, AssignableLead[]>();
        leads.forEach((lead, i) => {
            const person = people[i % people.length]!;
            groups.set(person.id, [...(groups.get(person.id) ?? []), lead]);
        });
        const batchId = randomUUID();
        let assigned = 0;
        let skipped = 0;
        const perPerson: DistributeResult['perPerson'] = [];
        for (const person of people) {
            const group = groups.get(person.id);
            if (!group) continue;
            const result = await this.move(auth, group, person, {
                method: 'BULK',
                reasonCode: 'MOVED_FROM_PERSON',
                audit: AuditAction.LeadsMovedFromPerson,
                entity: { type: 'staff', id: from.publicId },
                ip: meta.ip ?? null,
                batchId,
            });
            assigned += result.moved;
            skipped += result.skipped;
            if (result.moved > 0) perPerson.push({ id: person.publicId, name: person.name, count: result.moved });
        }
        return { assigned, skipped, perPerson };
    }

    private async targetOf(auth: AuthContext, publicId: string): Promise<StaffRef> {
        const target = await this.iam.getStaffRef(publicId);
        if (!target || !target.isActive || !assigneeRolesFor(auth).includes(target.role)) {
            const who = auth.role === 'ADMIN' ? 'an active admin, sales manager or BDA' : 'an active sales manager or BDA';
            throw new BadRequestException({
                code: 'ASSIGNEE_INVALID',
                message: `Choose ${who}`,
                fields: { toUserId: `Choose ${who}` },
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
        const target = await this.targetOf(auth, input.toUserId);
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
        const target = await this.targetOf(auth, input.toUserId);
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
            method: 'BULK' | 'EQUAL_DISTRIBUTION';
            reasonCode: string;
            audit:
                | typeof AuditAction.LeadsHandedOver
                | typeof AuditAction.LeadsBulkAssigned
                | typeof AuditAction.LeadsDistributed
                | typeof AuditAction.LeadsMovedFromPerson;
            entity: { type: string; id: string | null };
            ip: string | null;
            /** Lets several moves of one distribution share a batch. */
            batchId?: string;
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
            await this.engagement.reassignOpenTasks(moved.map((lead) => lead.id), target.id);
            const batchId = how.batchId ?? randomUUID();
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
            // The new owner hears about it, unless they did it themselves.
            if (target.id !== actorId) await this.inbox.assigned(target.id, moved.map((lead) => lead.id));
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
