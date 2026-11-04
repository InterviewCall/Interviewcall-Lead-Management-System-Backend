import { Injectable } from '@nestjs/common';
import { isUniqueViolation, ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import {
    ALL_ROLES_FOR_NEW_FIELDS,
    type CustomFieldView,
    type IdentityKey,
    type ImportedLeadFields,
    type LeadListRecord,
    type LeadMatch,
    type LeadDetailRow,
    type LeadListOption,
    type LeadListRow,
    type LeadScope,
    type LeadSearch,
    type LeadSourceView,
} from './leads.types.js';

/** What a new imported lead is created with. */
export interface NewImportedLead {
    fields: ImportedLeadFields;
    sourceId: number;
    ownerId: bigint | null;
    listId: bigint;
    ref: string;
    initialScore: number;
    touchpointPayload: Record<string, unknown>;
    now: Date;
}

/**
 * The only class allowed to read or write this module's tables:
 * leads, lead_identities, lead_sources, touchpoints, form_responses, bookings, custom_field_definitions, saved_views,
 * lead_lists, lead_list_members, lead_score_entries.
 * Other modules call LeadsService instead of touching these models.
 */
@Injectable()
export class LeadsRepository {
    /** True when a write lost a race on a unique index. */
    isUniqueConflict(error: unknown): boolean {
        return isUniqueViolation(error);
    }

    constructor(private readonly db: ModelService) {}

    // ---- sources and custom fields ----

    listActiveSources(): Promise<LeadSourceView[]> {
        return this.db.leadSource.findMany({
            where: { isActive: true },
            select: { id: true, name: true, group: true },
            orderBy: [{ matchOrder: 'asc' }, { name: 'asc' }],
        });
    }

    findActiveSource(id: number): Promise<LeadSourceView | null> {
        return this.db.leadSource.findFirst({
            where: { id, isActive: true },
            select: { id: true, name: true, group: true },
        });
    }

    listCustomFields(): Promise<CustomFieldView[]> {
        return this.db.customFieldDefinition.findMany({
            where: { isActive: true },
            select: { key: true, label: true },
            orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        });
    }

    async ensureCustomFields(fields: CustomFieldView[]): Promise<void> {
        if (fields.length === 0) return;
        const existing = await this.db.customFieldDefinition.findMany({
            where: { key: { in: fields.map((f) => f.key) } },
            select: { key: true },
        });
        const have = new Set(existing.map((f) => f.key));
        const missing = fields.filter((f) => !have.has(f.key));
        if (missing.length === 0) return;
        const last = await this.db.customFieldDefinition.aggregate({
            _max: { sortOrder: true },
        });
        const start = (last._max.sortOrder ?? 0) + 1;
        await this.db.customFieldDefinition.createMany({
            data: missing.map((f, i) => ({
                key: f.key,
                label: f.label,
                type: 'TEXT' as const,
                visibleRoles: [...ALL_ROLES_FOR_NEW_FIELDS],
                sortOrder: start + i,
            })),
            // Two imports can ask for the same new field at the same moment.
            skipDuplicates: true,
        });
    }

    // ---- lists ----

    findListByName(name: string): Promise<(LeadListRecord & { originRef: string | null }) | null> {
        return this.db.leadList.findUnique({
            where: { name },
            select: { id: true, publicId: true, name: true, originRef: true },
        });
    }

    findListByOriginRef(originRef: string): Promise<LeadListRecord | null> {
        return this.db.leadList.findUnique({
            where: { originRef },
            select: { id: true, publicId: true, name: true },
        });
    }

    createList(data: {
        name: string;
        description: string | null;
        originRef: string;
        createdById: bigint;
    }): Promise<LeadListRecord> {
        return this.db.leadList.create({
            data,
            select: { id: true, publicId: true, name: true },
        });
    }

    countListMembers(listId: bigint): Promise<number> {
        return this.db.leadListMember.count({ where: { listId } });
    }

    // ---- matching ----

    /** Every lead that holds one of these identities. */
    async findByIdentities(
        identities: IdentityKey[],
    ): Promise<Map<string, LeadMatch>> {
        const found = new Map<string, LeadMatch>();
        if (identities.length === 0) return found;
        const emails = identities.filter((i) => i.type === 'EMAIL').map((i) => i.value);
        const phones = identities.filter((i) => i.type === 'PHONE').map((i) => i.value);
        const or: Prisma.LeadIdentityWhereInput[] = [];
        if (emails.length) or.push({ type: 'EMAIL', value: { in: emails } });
        if (phones.length) or.push({ type: 'PHONE', value: { in: phones } });
        const rows = await this.db.leadIdentity.findMany({
            where: { OR: or },
            select: {
                type: true,
                value: true,
                lead: { select: { id: true, publicId: true, fullName: true, mergedIntoId: true } },
            },
        });
        for (const row of rows) {
            // A lead that was merged into another stands for that other lead.
            let lead = row.lead;
            if (lead.mergedIntoId !== null) {
                const target = await this.db.lead.findUnique({
                    where: { id: lead.mergedIntoId },
                    select: { id: true, publicId: true, fullName: true, mergedIntoId: true },
                });
                if (target) lead = target;
            }
            found.set(`${row.type}:${row.value}`, {
                leadId: lead.id,
                publicId: lead.publicId,
                fullName: lead.fullName,
            });
        }
        return found;
    }

    /** The leads whose touchpoints carry these references, keyed by reference. */
    async findTouchpointLeads(refs: string[]): Promise<Map<string, bigint>> {
        const rows = await this.db.touchpoint.findMany({
            where: { externalRef: { in: refs } },
            select: { externalRef: true, leadId: true },
        });
        const found = new Map<string, bigint>();
        for (const row of rows) {
            if (row.externalRef) found.set(row.externalRef, row.leadId);
        }
        return found;
    }

    findLeadMatchById(leadId: bigint): Promise<LeadMatch | null> {
        return this.db.lead
            .findUnique({
                where: { id: leadId },
                select: { id: true, publicId: true, fullName: true },
            })
            .then((lead) =>
                lead
                    ? { leadId: lead.id, publicId: lead.publicId, fullName: lead.fullName }
                    : null,
            );
    }

    // ---- writes ----

    /**
     * Creates the lead with its identities, first touchpoint, list membership and starting score
     * in one transaction. Throws on a unique violation (checked with isUniqueViolation) when
     * another request got the same person in first.
     */
    async createImportedLead(input: NewImportedLead): Promise<bigint> {
        const f = input.fields;
        const identities: { type: 'EMAIL' | 'PHONE'; value: string }[] = [];
        if (f.email) identities.push({ type: 'EMAIL', value: f.email });
        if (f.phoneLast10) identities.push({ type: 'PHONE', value: f.phoneLast10 });

        const lead = await this.db.lead.create({
            data: {
                fullName: f.fullName,
                email: f.email,
                phoneE164: f.phoneE164,
                phoneLast10: f.phoneLast10,
                currentCompany: f.currentCompany,
                currentCtc: f.currentCtc,
                graduationYear: f.graduationYear,
                domain: f.domain,
                userType: f.userType,
                custom: Object.keys(f.custom).length ? f.custom : Prisma.JsonNull,
                ownerId: input.ownerId,
                firstSourceId: input.sourceId,
                capturedAt: input.now,
                leadScore: input.initialScore,
                scoreUpdatedAt: input.initialScore !== 0 ? input.now : null,
                identities: { create: identities },
                touchpoints: {
                    create: {
                        sourceId: input.sourceId,
                        kind: 'IMPORT',
                        externalRef: input.ref,
                        payload: input.touchpointPayload as Prisma.InputJsonValue,
                        occurredAt: input.now,
                    },
                },
                listMembers: { create: { listId: input.listId } },
                ...(input.initialScore !== 0
                    ? {
                          scoreEntries: {
                              create: {
                                  points: input.initialScore,
                                  reason: 'IMPORT_INITIAL',
                                  ref: input.ref.slice(0, 100),
                              },
                          },
                      }
                    : {}),
            },
            select: { id: true },
        });
        return lead.id;
    }

    /** Records that a known person turned up again, with this source and these details. */
    async addImportTouchpoint(data: {
        leadId: bigint;
        sourceId: number;
        ref: string;
        payload: Record<string, unknown>;
        now: Date;
    }): Promise<void> {
        try {
            await this.db.touchpoint.create({
                data: {
                    leadId: data.leadId,
                    sourceId: data.sourceId,
                    kind: 'IMPORT',
                    externalRef: data.ref,
                    payload: data.payload as Prisma.InputJsonValue,
                    occurredAt: data.now,
                },
            });
        } catch (error) {
            // Already recorded by an earlier attempt of the same row.
            if (!isUniqueViolation(error)) throw error;
        }
    }

    /**
     * Fills in the fields this lead has no value for, and adds the email or phone it did not have
     * (unless another lead already holds it). Returns the names of the fields that were filled.
     */
    async fillEmptyFields(
        leadId: bigint,
        fields: ImportedLeadFields,
    ): Promise<string[]> {
        return this.db.$transaction(async (tx) => {
            const lead = await tx.lead.findUnique({
                where: { id: leadId },
                select: {
                    email: true,
                    phoneE164: true,
                    phoneLast10: true,
                    currentCompany: true,
                    currentCtc: true,
                    graduationYear: true,
                    domain: true,
                    userType: true,
                    custom: true,
                },
            });
            if (!lead) return [];

            const data: Prisma.LeadUpdateInput = {};
            const filled: string[] = [];
            const empty = (v: string | null) => v === null || v === '';
            const fill = <K extends 'currentCompany' | 'currentCtc' | 'graduationYear' | 'domain'>(
                key: K,
                label: string,
            ) => {
                if (empty(lead[key]) && fields[key]) {
                    data[key] = fields[key];
                    filled.push(label);
                }
            };
            fill('currentCompany', 'currentCompany');
            fill('currentCtc', 'currentCtc');
            fill('graduationYear', 'graduationYear');
            fill('domain', 'domain');
            if (lead.userType === 'UNKNOWN' && fields.userType !== 'UNKNOWN') {
                data.userType = fields.userType;
                filled.push('userType');
            }

            if (fields.email && empty(lead.email)) {
                const taken = await tx.leadIdentity.findUnique({
                    where: { type_value: { type: 'EMAIL', value: fields.email } },
                    select: { id: true },
                });
                if (!taken) {
                    await tx.leadIdentity.create({
                        data: { leadId, type: 'EMAIL', value: fields.email },
                    });
                    data.email = fields.email;
                    filled.push('email');
                }
            }
            if (fields.phoneLast10 && empty(lead.phoneLast10)) {
                const taken = await tx.leadIdentity.findUnique({
                    where: { type_value: { type: 'PHONE', value: fields.phoneLast10 } },
                    select: { id: true },
                });
                if (!taken) {
                    await tx.leadIdentity.create({
                        data: { leadId, type: 'PHONE', value: fields.phoneLast10 },
                    });
                    data.phoneLast10 = fields.phoneLast10;
                    data.phoneE164 = fields.phoneE164;
                    filled.push('phone');
                }
            }

            const existingCustom =
                lead.custom && typeof lead.custom === 'object' && !Array.isArray(lead.custom)
                    ? (lead.custom as Record<string, unknown>)
                    : {};
            const newCustom = Object.entries(fields.custom).filter(
                ([key]) => existingCustom[key] === undefined || existingCustom[key] === '',
            );
            if (newCustom.length > 0) {
                data.custom = {
                    ...existingCustom,
                    ...Object.fromEntries(newCustom),
                } as Prisma.InputJsonValue;
                filled.push(...newCustom.map(([key]) => `custom.${key}`));
            }

            if (filled.length > 0) await tx.lead.update({ where: { id: leadId }, data });
            return filled;
        });
    }

    /**
     * Moves the running total and adds the ledger entry, together. The lead row is updated first:
     * that takes its exclusive lock before anything else, so two scores arriving at the same moment
     * queue up behind each other instead of deadlocking (inserting the entry first takes a shared
     * lock through the foreign key, and two of those cannot both upgrade).
     */
    async addScore(data: {
        leadId: bigint;
        points: number;
        reason: string;
        ref: string | null;
        now: Date;
    }): Promise<number> {
        return this.db.$transaction(async (tx) => {
            const lead = await tx.lead.update({
                where: { id: data.leadId },
                data: { leadScore: { increment: data.points }, scoreUpdatedAt: data.now },
                select: { leadScore: true },
            });
            await tx.leadScoreEntry.create({
                data: {
                    leadId: data.leadId,
                    points: data.points,
                    reason: data.reason,
                    ref: data.ref,
                    createdAt: data.now,
                },
            });
            return lead.leadScore;
        });
    }

    // ---- reading leads (the list and the lead page) ----

    private scopeWhere(scope: LeadScope): Prisma.LeadWhereInput {
        const base: Prisma.LeadWhereInput = { mergedIntoId: null, anonymisedAt: null };
        switch (scope.kind) {
            case 'ALL':
                return base;
            case 'OWNED_BY':
                return { ...base, owner: { publicId: scope.staffPublicId } };
            case 'OPEN_OPPORTUNITY':
                return { ...base, opportunities: { some: { status: 'OPEN' } } };
        }
    }

    private viewWhere(view: LeadSearch['view'], me: string): Prisma.LeadWhereInput {
        switch (view) {
            case 'mine':
                return { owner: { publicId: me } };
            case 'unassigned':
                return { ownerId: null };
            case 'booked':
                return { opportunities: { some: { status: 'OPEN', scheduledCallAt: { not: null } } } };
            case 'hot':
                return { temperature: 'HOT' };
            case 'due':
                return { nextFollowupAt: { lte: new Date() } };
            default:
                return {};
        }
    }

    private searchWhere(q: LeadSearch): Prisma.LeadWhereInput {
        const filters: Prisma.LeadWhereInput[] = [this.scopeWhere(q.scope), this.viewWhere(q.view, q.me)];
        const needle = q.search?.trim();
        if (needle) {
            const digits = needle.replace(/\D/g, '');
            const ors: Prisma.LeadWhereInput[] = [
                { fullName: { contains: needle } },
                { email: { contains: needle } },
            ];
            if (digits.length >= 3) ors.push({ phoneLast10: { contains: digits.slice(-10) } });
            filters.push({ OR: ors });
        }
        if (q.sourceId !== undefined) filters.push({ firstSourceId: q.sourceId });
        if (q.temperature) filters.push({ temperature: q.temperature });
        if (q.stage) {
            filters.push({
                opportunities: { some: { status: 'OPEN', stage: q.stage as Prisma.OpportunityWhereInput['stage'] } },
            });
        }
        if (q.lifecycle) filters.push({ lifecycleStage: q.lifecycle as Prisma.LeadWhereInput['lifecycleStage'] });
        if (q.ownerId === 'none') filters.push({ ownerId: null });
        else if (q.ownerId) filters.push({ owner: { publicId: q.ownerId } });
        if (q.listId) filters.push({ listMembers: { some: { list: { publicId: q.listId } } } });
        return { AND: filters };
    }

    private static readonly LIST_SELECT = {
        id: true,
        publicId: true,
        fullName: true,
        email: true,
        phoneE164: true,
        lifecycleStage: true,
        temperature: true,
        leadScore: true,
        capturedAt: true,
        nextFollowupAt: true,
        owner: { select: { publicId: true, name: true } },
        firstSource: { select: { id: true, name: true } },
        // The newest opportunity decides the stage shown on the list.
        opportunities: {
            orderBy: { openedAt: 'desc' as const },
            take: 1,
            select: { stage: true, status: true, scheduledCallAt: true },
        },
    } satisfies Prisma.LeadSelect;

    async searchLeads(q: LeadSearch): Promise<{ rows: LeadListRow[]; total: number }> {
        const where = this.searchWhere(q);
        const [rows, total] = await Promise.all([
            this.db.lead.findMany({
                where,
                select: LeadsRepository.LIST_SELECT,
                orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
                skip: q.skip,
                take: q.take,
            }),
            this.db.lead.count({ where }),
        ]);
        return { rows: rows as LeadListRow[], total };
    }

    /** How many leads each saved view holds, within what the person may see. */
    async countViews(scope: LeadScope, me: string): Promise<Record<LeadSearch['view'], number>> {
        const views = ['all', 'mine', 'unassigned', 'booked', 'hot', 'due'] as const;
        const counts = await Promise.all(
            views.map((view) =>
                this.db.lead.count({ where: { AND: [this.scopeWhere(scope), this.viewWhere(view, me)] } }),
            ),
        );
        return Object.fromEntries(views.map((v, i) => [v, counts[i]])) as Record<LeadSearch['view'], number>;
    }

    async findLeadDetail(publicId: string, scope: LeadScope): Promise<LeadDetailRow | null> {
        const lead = await this.db.lead.findFirst({
            where: { AND: [this.scopeWhere(scope), { publicId }] },
            select: {
                ...LeadsRepository.LIST_SELECT,
                currentCompany: true,
                currentCtc: true,
                graduationYear: true,
                domain: true,
                userType: true,
                doNotContact: true,
                custom: true,
                lastActivityAt: true,
                listMembers: { select: { list: { select: { publicId: true, name: true } } } },
                scoreEntries: {
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    take: 50,
                    select: { id: true, points: true, reason: true, createdAt: true },
                },
                events: {
                    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
                    take: 100,
                    select: { id: true, type: true, actorType: true, actorId: true, data: true, occurredAt: true },
                },
            },
        });
        if (!lead) return null;
        const opportunity = lead.opportunities[0];
        const detailOpportunity = opportunity
            ? await this.db.opportunity.findFirst({
                  where: { leadId: lead.id },
                  orderBy: { openedAt: 'desc' },
                  select: {
                      stage: true,
                      status: true,
                      openedAt: true,
                      stageChangedAt: true,
                      closedAt: true,
                      lostNote: true,
                      lostReason: { select: { name: true } },
                  },
              })
            : null;
        return { ...(lead as unknown as LeadDetailRow), detailOpportunity };
    }

    /** Lists people can filter by, newest first. */
    async listLeadLists(scope: LeadScope): Promise<LeadListOption[]> {
        const lists = await this.db.leadList.findMany({
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
                publicId: true,
                name: true,
                _count: { select: { members: scope.kind === 'ALL' ? true : { where: { lead: this.scopeWhere(scope) } } } },
            },
        });
        return lists.map((l) => ({ id: l.publicId, name: l.name, members: l._count.members }));
    }

    /** The lead if this person may see it: its id, owner and contact stage. */
    findMarkable(publicId: string, scope: LeadScope) {
        return this.db.lead.findFirst({
            where: { AND: [this.scopeWhere(scope), { publicId }] },
            select: { id: true, lifecycleStage: true, ownerId: true },
        });
    }

    findLifecycle(leadId: bigint) {
        return this.db.lead.findUnique({ where: { id: leadId }, select: { lifecycleStage: true } });
    }

    /** Changes the contact stage only if it is still `from`, so two people marking at once cannot overwrite each other silently. */
    async updateLifecycle(leadId: bigint, from: string, to: string): Promise<boolean> {
        const { count } = await this.db.lead.updateMany({
            where: { id: leadId, lifecycleStage: from as Prisma.LeadWhereInput['lifecycleStage'] },
            data: { lifecycleStage: to as Prisma.LeadUpdateManyMutationInput['lifecycleStage'] },
        });
        return count === 1;
    }

    /** Names of the owners that have leads, for the owner filter. */
    async listLeadOwners(): Promise<Array<{ id: string; name: string }>> {
        const owners = await this.db.staffUser.findMany({
            where: { ownedLeads: { some: {} } },
            select: { publicId: true, name: true },
            orderBy: { name: 'asc' },
        });
        return owners.map((o) => ({ id: o.publicId, name: o.name }));
    }
}
