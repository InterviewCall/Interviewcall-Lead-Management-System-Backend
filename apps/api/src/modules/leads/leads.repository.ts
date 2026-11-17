import { Injectable } from '@nestjs/common';
import { isUniqueViolation, ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import {
    ALL_ROLES_FOR_NEW_FIELDS,
    type AssignableLead,
    type BatchRow,
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
    type BoardCardRow,
    type BoardFilters,
    type BoardRows,
    type BookingInput,
    type BookingCheckRow,
    type OwnerLoadRow,
    type QueueFilters,
    type QueueRows,
    type EditableField,
    type LeadDetailsPatch,
    type LeadDetailsUpdate,
    type BookingRow,
    type FormResponseInput,
    type LeadSourceRule,
    type LeadSourceView,
    type TemperatureName,
    type TouchpointKindName,
    type VslDepthName,
    type VslState,
    type VslSummaryRow,
} from './leads.types.js';
import { depthWeight, priorityRankOf } from './vsl-priority.js';

/** The ledger reason of the entry that carries a lead's VSL form score. */
const FORM_SCORE_REASON = 'VSL_FORM_SCORE';

/** What a new imported lead is created with. */
export interface NewImportedLead {
    fields: ImportedLeadFields;
    sourceId: number;
    ownerId: bigint | null;
    listId: bigint | null;
    ref: string;
    initialScore: number;
    touchpointPayload: Record<string, unknown>;
    kind?: TouchpointKindName;
    scoreReason?: string;
    now: Date;
}

/**
 * The only class allowed to read or write this module's tables:
 * leads, lead_identities, lead_sources, touchpoints, form_responses, bookings, custom_field_definitions, saved_views,
 * lead_lists, lead_list_members, lead_score_entries.
 * Other modules call LeadsService instead of touching these models.
 */
/** Another lead holds the email or phone an edit wanted: aborts the edit's transaction. */
class IdentityTaken extends Error {
    constructor(
        readonly field: 'email' | 'phone',
        readonly leadId: bigint,
    ) {
        super('identity taken');
    }
}

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

    /** The active sources with their matching rules, in the order the rules are tried. */
    listSourceRules(): Promise<LeadSourceRule[]> {
        return this.db.leadSource.findMany({
            where: { isActive: true },
            select: { id: true, name: true, group: true, matchRule: true },
            orderBy: [{ matchOrder: 'asc' }, { name: 'asc' }],
        });
    }

    /** Every source, active or not, with how many leads first came from it. For the admin's Sources screen. */
    async listAllSources() {
        const [rows, counts] = await Promise.all([
            this.db.leadSource.findMany({
                select: { id: true, name: true, group: true, isActive: true, matchRule: true, createdAt: true },
                orderBy: [{ isActive: 'desc' }, { matchOrder: 'asc' }, { name: 'asc' }],
            }),
            this.db.lead.groupBy({ by: ['firstSourceId'], where: { mergedIntoId: null }, _count: { _all: true } }),
        ]);
        const byId = new Map(counts.map((c) => [c.firstSourceId, c._count._all]));
        return rows.map((r) => ({ ...r, leads: byId.get(r.id) ?? 0 }));
    }

    findSourceById(id: number) {
        return this.db.leadSource.findUnique({ where: { id }, select: { id: true, name: true, group: true, isActive: true, matchRule: true } });
    }

    /** A new source an admin added. Sources added by hand carry no VSL rule and are tried last. */
    async createSource(data: { name: string; group: string }): Promise<number> {
        const row = await this.db.leadSource.create({
            data: { name: data.name, group: data.group as Prisma.LeadSourceCreateInput['group'], matchOrder: 800 },
            select: { id: true },
        });
        return row.id;
    }

    async updateSource(id: number, data: { name?: string; group?: string; isActive?: boolean }): Promise<void> {
        await this.db.leadSource.update({
            where: { id },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.group !== undefined ? { group: data.group as Prisma.LeadSourceUpdateInput['group'] } : {}),
                ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
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

    /** Every field definition, retired ones too, in display order. */
    listCustomFieldDefs() {
        return this.db.customFieldDefinition.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
    }

    findCustomFieldDef(key: string) {
        return this.db.customFieldDefinition.findUnique({ where: { key } });
    }

    async createCustomFieldDef(data: {
        key: string; label: string; type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'MULTISELECT' | 'BOOLEAN';
        options: string[] | null; isRequired: boolean; visibleRoles: string[];
    }) {
        const last = await this.db.customFieldDefinition.aggregate({ _max: { sortOrder: true } });
        return this.db.customFieldDefinition.create({
            data: { ...data, options: data.options ?? Prisma.JsonNull, sortOrder: (last._max.sortOrder ?? 0) + 1 },
        });
    }

    updateCustomFieldDef(key: string, data: { label?: string; options?: string[]; isRequired?: boolean; visibleRoles?: string[]; isActive?: boolean }) {
        return this.db.customFieldDefinition.update({ where: { key }, data });
    }

    /** Sets or clears these keys on the lead's custom values, leaving the others. Null removes a key. */
    async mergeLeadCustom(leadId: bigint, values: Record<string, unknown>): Promise<void> {
        await this.db.$transaction(async (tx) => {
            const row = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { custom: true } });
            const current = row.custom && typeof row.custom === 'object' && !Array.isArray(row.custom) ? (row.custom as Record<string, unknown>) : {};
            const next: Record<string, unknown> = { ...current };
            for (const [k, v] of Object.entries(values)) {
                if (v === null) delete next[k];
                else next[k] = v;
            }
            await tx.lead.update({ where: { id: leadId }, data: { custom: Object.keys(next).length ? (next as Prisma.InputJsonObject) : Prisma.JsonNull } });
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

    // ---- saved views ----

    listSavedViews(userId: bigint) {
        return this.db.savedView.findMany({
            where: { OR: [{ userId }, { isShared: true }] },
            select: { id: true, name: true, filters: true, isShared: true, userId: true, user: { select: { name: true } } },
            orderBy: [{ isShared: 'desc' }, { name: 'asc' }],
        });
    }

    countSavedViews(userId: bigint) {
        return this.db.savedView.count({ where: { userId } });
    }

    async savedViewNameTaken(userId: bigint, name: string): Promise<boolean> {
        const rows = await this.db.savedView.findMany({ where: { userId }, select: { name: true } });
        return rows.some((r) => r.name.toLowerCase() === name.toLowerCase());
    }

    createSavedView(data: { userId: bigint; name: string; filters: Prisma.InputJsonValue; isShared: boolean }) {
        return this.db.savedView.create({
            data,
            select: { id: true, name: true, filters: true, isShared: true, userId: true, user: { select: { name: true } } },
        });
    }

    findSavedView(id: bigint) {
        return this.db.savedView.findUnique({ where: { id }, select: { id: true, userId: true } });
    }

    async deleteSavedView(id: bigint): Promise<void> {
        await this.db.savedView.deleteMany({ where: { id } });
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
                        kind: input.kind ?? 'IMPORT',
                        externalRef: input.ref,
                        payload: input.touchpointPayload as Prisma.InputJsonValue,
                        occurredAt: input.now,
                    },
                },
                ...(input.listId !== null ? { listMembers: { create: { listId: input.listId } } } : {}),
                ...(input.initialScore !== 0
                    ? {
                          scoreEntries: {
                              create: {
                                  points: input.initialScore,
                                  reason: input.scoreReason ?? 'IMPORT_INITIAL',
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
        kind?: TouchpointKindName;
        now: Date;
    }): Promise<void> {
        try {
            await this.db.touchpoint.create({
                data: {
                    leadId: data.leadId,
                    sourceId: data.sourceId,
                    kind: data.kind ?? 'IMPORT',
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
                    editedFields: true,
                },
            });
            if (!lead) return [];

            const data: Prisma.LeadUpdateInput = {};
            const filled: string[] = [];
            // A field a person edited (or cleared on purpose) is theirs: a source never fills it back in.
            const edited = new Set(Array.isArray(lead.editedFields) ? (lead.editedFields as string[]) : []);
            const empty = (v: string | null) => v === null || v === '';
            const fill = <K extends 'currentCompany' | 'currentCtc' | 'graduationYear' | 'domain'>(
                key: K,
                label: string,
            ) => {
                if (empty(lead[key]) && fields[key] && !edited.has(key)) {
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

            if (fields.email && empty(lead.email) && !edited.has('email')) {
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
            if (fields.phoneLast10 && empty(lead.phoneLast10) && !edited.has('phone')) {
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
        if (q.capturedFrom || q.capturedTo) {
            filters.push({ capturedAt: { ...(q.capturedFrom ? { gte: q.capturedFrom } : {}), ...(q.capturedTo ? { lt: q.capturedTo } : {}) } });
        }
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

    // ---- the pipeline board ----

    private static readonly BOARD_STAGES = [
        'CALL_1_PENDING',
        'CALL_1',
        'TEST',
        'CALL_2',
        'PSYCHOMETRIC_SESSION',
        'DECISION_OBJECTION',
        'PAYMENT_FINANCING',
        'CLOSED_WON',
    ] as const;

    private boardLeadWhere(scope: LeadScope, filters: BoardFilters): Prisma.LeadWhereInput {
        const and: Prisma.LeadWhereInput[] = [this.scopeWhere(scope)];
        if (filters.temperature) and.push({ temperature: filters.temperature });
        if (filters.ownerId === 'none') and.push({ ownerId: null });
        else if (filters.ownerId) and.push({ owner: { publicId: filters.ownerId } });
        return { AND: and };
    }

    /**
     * The board: how many open opportunities sit at each stage, and the newest few cards of each. Closed Won holds
     * what was won since `monthStart`. Counts follow `countScope` and cards follow `cardScope`, which differ only
     * for a closer (the numbers are the team's, but they open only the leads they may see).
     */
    async board(
        cardScope: LeadScope,
        countScope: LeadScope,
        filters: BoardFilters,
        perColumn: number,
        monthStart: Date,
    ): Promise<BoardRows> {
        const countLead = this.boardLeadWhere(countScope, filters);
        const cardLead = this.boardLeadWhere(cardScope, filters);
        const open: Prisma.OpportunityWhereInput = { status: 'OPEN' };
        const wonSince: Prisma.OpportunityWhereInput = { status: 'WON', closedAt: { gte: monthStart } };

        const [grouped, won, lost, columns] = await Promise.all([
            this.db.opportunity.groupBy({ by: ['stage'], where: { ...open, lead: countLead }, _count: { _all: true } }),
            this.db.opportunity.count({ where: { ...wonSince, lead: countLead } }),
            this.db.opportunity.count({ where: { status: 'LOST', closedAt: { gte: monthStart }, lead: countLead } }),
            Promise.all(
                LeadsRepository.BOARD_STAGES.map((stage) =>
                    this.db.opportunity.findMany({
                        where: stage === 'CLOSED_WON' ? { ...wonSince, lead: cardLead } : { ...open, stage, lead: cardLead },
                        orderBy: [{ stageChangedAt: 'desc' }, { id: 'desc' }],
                        take: perColumn,
                        select: {
                            stage: true,
                            stageChangedAt: true,
                            scheduledCallAt: true,
                            lead: {
                                select: {
                                    publicId: true,
                                    fullName: true,
                                    currentCompany: true,
                                    domain: true,
                                    temperature: true,
                                    nextFollowupAt: true,
                                    owner: { select: { publicId: true, name: true } },
                                    firstSource: { select: { name: true } },
                                },
                            },
                        },
                    }),
                ),
            ),
        ]);

        const counts: Record<string, number> = Object.fromEntries(LeadsRepository.BOARD_STAGES.map((s) => [s, 0]));
        for (const g of grouped) counts[g.stage] = g._count._all;
        counts.CLOSED_WON = won;
        const cards = Object.fromEntries(LeadsRepository.BOARD_STAGES.map((s, i) => [s, columns[i] as BoardCardRow[]]));
        return { counts, lostThisMonth: lost, cards };
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
                vslDepth: true,
                formScore: true,
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
        const select = {
            stage: true,
            status: true,
            openedAt: true,
            stageChangedAt: true,
            closedAt: true,
            lostNote: true,
            lostReason: { select: { name: true } },
            enrolment: { select: { program: true, feeAmount: true, amountCollected: true, paymentMode: true, note: true, updatedAt: true } },
        } as const;
        // The open one if there is one, else the latest; never one closed by a merge.
        const detailOpportunity = opportunity
            ? ((await this.db.opportunity.findFirst({ where: { leadId: lead.id, status: 'OPEN' }, select })) ??
              (await this.db.opportunity.findFirst({ where: { leadId: lead.id, status: { not: 'MERGED' } }, orderBy: { openedAt: 'desc' }, select })))
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

    /**
     * Changes a lead's details by hand. The email and the phone are also the lead's identities, so the old
     * value's identity is replaced by the new one; if another lead already holds the new value nothing is
     * changed. Every field changed is remembered, so a later import or signup never overwrites it.
     */
    async updateDetails(leadId: bigint, patch: LeadDetailsPatch): Promise<LeadDetailsUpdate> {
        try {
            return await this.db.$transaction(async (tx) => {
                const rows = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`;
                if (rows.length === 0) return { kind: 'NOT_FOUND' as const };
                const lead = await tx.lead.findUnique({
                    where: { id: leadId },
                    select: {
                        fullName: true,
                        email: true,
                        phoneLast10: true,
                        currentCompany: true,
                        currentCtc: true,
                        graduationYear: true,
                        domain: true,
                        editedFields: true,
                    },
                });
                if (!lead) return { kind: 'NOT_FOUND' as const };

                const data: Prisma.LeadUpdateInput = {};
                const changed: EditableField[] = [];
                if (patch.fullName !== undefined && patch.fullName !== lead.fullName) {
                    data.fullName = patch.fullName;
                    changed.push('fullName');
                }
                for (const key of ['currentCompany', 'currentCtc', 'graduationYear', 'domain'] as const) {
                    const value = patch[key];
                    if (value !== undefined && value !== lead[key]) {
                        data[key] = value;
                        changed.push(key);
                    }
                }

                const swap = async (type: 'EMAIL' | 'PHONE', from: string | null, to: string | null): Promise<bigint | null> => {
                    if (to !== null) {
                        const holder = await tx.leadIdentity.findUnique({ where: { type_value: { type, value: to } }, select: { leadId: true } });
                        if (holder && holder.leadId !== leadId) return holder.leadId;
                        if (!holder) await tx.leadIdentity.create({ data: { leadId, type, value: to } });
                    }
                    if (from !== null) await tx.leadIdentity.deleteMany({ where: { leadId, type, value: from } });
                    return null;
                };
                if (patch.email !== undefined && patch.email !== lead.email) {
                    const holder = await swap('EMAIL', lead.email, patch.email);
                    // Thrown, not returned, so an identity already swapped in this edit is rolled back too.
                    if (holder !== null) throw new IdentityTaken('email', holder);
                    data.email = patch.email;
                    changed.push('email');
                }
                const newLast10 = patch.phone === undefined ? undefined : (patch.phone?.phoneLast10 ?? null);
                if (newLast10 !== undefined && newLast10 !== lead.phoneLast10) {
                    const holder = await swap('PHONE', lead.phoneLast10, newLast10);
                    if (holder !== null) throw new IdentityTaken('phone', holder);
                    data.phoneLast10 = newLast10;
                    data.phoneE164 = patch.phone?.phoneE164 ?? null;
                    changed.push('phone');
                }
                if (changed.length === 0) return { kind: 'UPDATED' as const, changed };

                const before = Array.isArray(lead.editedFields) ? (lead.editedFields as string[]) : [];
                data.editedFields = [...new Set([...before, ...changed])];
                await tx.lead.update({ where: { id: leadId }, data });
                return { kind: 'UPDATED' as const, changed };
            });
        } catch (error) {
            if (error instanceof IdentityTaken) return { kind: 'TAKEN', field: error.field, leadId: error.leadId };
            // Someone added the same email or phone to another lead in the same moment.
            if (isUniqueViolation(error)) {
                const field = patch.email !== undefined ? 'email' : 'phone';
                const value = field === 'email' ? patch.email : (patch.phone?.phoneLast10 ?? null);
                if (value) {
                    const holder = await this.db.leadIdentity.findUnique({
                        where: { type_value: { type: field === 'email' ? 'EMAIL' : 'PHONE', value } },
                        select: { leadId: true },
                    });
                    if (holder && holder.leadId !== leadId) return { kind: 'TAKEN', field, leadId: holder.leadId };
                }
            }
            throw error;
        }
    }

    findIdentityValues(leadId: bigint) {
        return this.db.lead.findUnique({ where: { id: leadId }, select: { email: true, phoneLast10: true } });
    }

    /**
     * The lead side of a merge, in one transaction: everything the duplicate (`dropId`) holds moves to the kept lead
     * (`keepId`): its email and phone identities, touchpoints, VSL forms and bookings, score history and lists. The kept
     * lead's own values win; its empty fields are filled from the duplicate (except fields a person edited); it keeps
     * the earliest capture, the furthest VSL step, the hotter temperature and the further contact stage. The form
     * score is counted once. Last of all the duplicate is marked as merged, so a merge cut short can be run again.
     * Returns the owner the kept lead ends with.
     */
    async absorbLead(keepId: bigint, dropId: bigint): Promise<{ ownerId: bigint | null }> {
        return this.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM leads WHERE id IN (${keepId}, ${dropId}) ORDER BY id FOR UPDATE`;
            const [keep, drop] = await Promise.all([
                tx.lead.findUniqueOrThrow({ where: { id: keepId } }),
                tx.lead.findUniqueOrThrow({ where: { id: dropId } }),
            ]);

            await tx.leadIdentity.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
            await tx.touchpoint.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
            await tx.formResponse.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
            await tx.booking.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
            await tx.leadScoreEntry.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
            const lists = await tx.leadListMember.findMany({ where: { leadId: dropId }, select: { listId: true, addedAt: true } });
            if (lists.length > 0) {
                await tx.leadListMember.createMany({ data: lists.map((l) => ({ listId: l.listId, leadId: keepId, addedAt: l.addedAt })), skipDuplicates: true });
                await tx.leadListMember.deleteMany({ where: { leadId: dropId } });
            }

            // The form score counts once: what the newest form says, as applyFormScore keeps it.
            const newestForm = await tx.formResponse.findFirst({ where: { leadId: keepId }, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], select: { score: true } });
            if (newestForm?.score !== null && newestForm?.score !== undefined) {
                const prior = await tx.leadScoreEntry.aggregate({ where: { leadId: keepId, reason: FORM_SCORE_REASON }, _sum: { points: true } });
                const delta = newestForm.score - (prior._sum.points ?? 0);
                if (delta !== 0) {
                    await tx.leadScoreEntry.create({ data: { leadId: keepId, points: delta, reason: FORM_SCORE_REASON, ref: `merge:${drop.publicId}` } });
                }
            }
            const total = await tx.leadScoreEntry.aggregate({ where: { leadId: keepId }, _sum: { points: true } });

            const edited = new Set(Array.isArray(keep.editedFields) ? (keep.editedFields as string[]) : []);
            const pick = <T>(field: string, mine: T | null, theirs: T | null): T | null => (mine !== null && mine !== '' ? mine : edited.has(field) ? mine : theirs);
            const LIFECYCLE_RANK: Record<string, number> = { NOT_INTERESTED: -2, EXHAUSTED_NOT_CONNECTED: -1, MARKETING_LEAD: 0, ENGAGED_LEAD: 1, PROSPECT: 2, ENROLLED: 3, LEARNER_ONBOARDED: 4 };
            const TEMP_RANK: Record<string, number> = { COLD: 1, WARM: 2, HOT: 3 };
            const minDate = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));
            const maxDate = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
            const vslDepth = depthWeight(drop.vslDepth) > depthWeight(keep.vslDepth) ? drop.vslDepth : keep.vslDepth;
            const temperature =
                keep.temperature && drop.temperature
                    ? TEMP_RANK[drop.temperature]! > TEMP_RANK[keep.temperature]! ? drop.temperature : keep.temperature
                    : (keep.temperature ?? drop.temperature);
            const formScore = newestForm?.score ?? keep.formScore ?? drop.formScore;
            const lifecycleStage = (LIFECYCLE_RANK[drop.lifecycleStage] ?? 0) > (LIFECYCLE_RANK[keep.lifecycleStage] ?? 0) ? drop.lifecycleStage : keep.lifecycleStage;
            const keepCustom = keep.custom && typeof keep.custom === 'object' && !Array.isArray(keep.custom) ? (keep.custom as Record<string, unknown>) : {};
            const dropCustom = drop.custom && typeof drop.custom === 'object' && !Array.isArray(drop.custom) ? (drop.custom as Record<string, unknown>) : {};
            const custom = { ...dropCustom, ...keepCustom };
            const ownerId = keep.ownerId ?? drop.ownerId;

            await tx.lead.update({
                where: { id: keepId },
                data: {
                    email: pick('email', keep.email, drop.email),
                    phoneE164: keep.phoneLast10 || edited.has('phone') ? keep.phoneE164 : drop.phoneE164,
                    phoneLast10: pick('phone', keep.phoneLast10, drop.phoneLast10),
                    currentCompany: pick('currentCompany', keep.currentCompany, drop.currentCompany),
                    currentCtc: pick('currentCtc', keep.currentCtc, drop.currentCtc),
                    graduationYear: pick('graduationYear', keep.graduationYear, drop.graduationYear),
                    domain: pick('domain', keep.domain, drop.domain),
                    userType: keep.userType === 'UNKNOWN' ? drop.userType : keep.userType,
                    lifecycleStage,
                    ownerId,
                    vslDepth,
                    formScore,
                    temperature,
                    priorityRank: priorityRankOf(vslDepth, temperature, formScore),
                    leadScore: total._sum.points ?? 0,
                    scoreUpdatedAt: new Date(),
                    doNotContact: keep.doNotContact || drop.doNotContact,
                    attemptCount: Math.max(keep.attemptCount, drop.attemptCount),
                    custom: Object.keys(custom).length > 0 ? (custom as Prisma.InputJsonValue) : Prisma.JsonNull,
                    capturedAt: minDate(keep.capturedAt, drop.capturedAt)!,
                    firstTouchAt: minDate(keep.firstTouchAt, drop.firstTouchAt),
                    lastActivityAt: maxDate(keep.lastActivityAt, drop.lastActivityAt),
                },
            });
            // The duplicate stays as a pointer, so old links and events still find the person.
            await tx.lead.update({ where: { id: dropId }, data: { mergedIntoId: keepId, nextFollowupAt: null } });
            return { ownerId };
        });
    }

    /** A lead and the one it was merged into, if any, by public id. For merging. */
    /**
     * Erasure: every personal detail of the lead goes (name, phone, email, company, answers, source payloads, custom
     * values) and its identities are released. The row stays so that counts, stages and revenue still add up.
     */
    async erase(leadId: bigint, at: Date): Promise<void> {
        await this.db.$transaction([
            this.db.lead.update({
                where: { id: leadId },
                data: {
                    fullName: 'Anonymised lead',
                    email: null,
                    phoneE164: null,
                    phoneLast10: null,
                    currentCompany: null,
                    currentCtc: null,
                    graduationYear: null,
                    domain: null,
                    custom: Prisma.DbNull,
                    editedFields: Prisma.DbNull,
                    nextFollowupAt: null,
                    anonymisedAt: at,
                },
            }),
            this.db.leadIdentity.deleteMany({ where: { leadId } }),
            this.db.touchpoint.updateMany({ where: { leadId }, data: { payload: Prisma.DbNull } }),
            this.db.formResponse.updateMany({ where: { leadId }, data: { answers: [] } }),
        ]);
    }

    findMergeCandidate(publicId: string) {
        return this.db.lead.findUnique({
            where: { publicId },
            select: { id: true, publicId: true, fullName: true, ownerId: true, mergedIntoId: true, anonymisedAt: true },
        });
    }

    /** Other leads with the same name, for "possible duplicates". Merged and anonymised leads are left out. */
    findSameName(leadId: bigint, fullName: string, take = 10) {
        return this.db.lead.findMany({
            where: { id: { not: leadId }, fullName: fullName.trim(), mergedIntoId: null, anonymisedAt: null },
            orderBy: { capturedAt: 'desc' },
            take,
            select: LeadsRepository.LIST_SELECT,
        });
    }

    /** Who a lead is and who owns it, to tell someone adding a person that they are already here. */
    findLeadOwnerView(leadId: bigint) {
        return this.db.lead.findUnique({
            where: { id: leadId },
            select: { id: true, publicId: true, fullName: true, ownerId: true, mergedIntoId: true, owner: { select: { publicId: true, name: true } } },
        });
    }

    /** Every lead this person owns that a new owner should take over: anything not enrolled, merged away or anonymised. */
    findHandoverLeadsOwnedBy(ownerId: bigint): Promise<AssignableLead[]> {
        return this.db.lead.findMany({
            where: {
                ownerId,
                mergedIntoId: null,
                anonymisedAt: null,
                lifecycleStage: { notIn: ['ENROLLED', 'LEARNER_ONBOARDED'] },
            },
            orderBy: [{ priorityRank: 'desc' }, { capturedAt: 'asc' }, { id: 'asc' }],
            select: LeadsRepository.ASSIGNABLE,
        });
    }

    countHandoverLeadsOwnedBy(ownerId: bigint): Promise<number> {
        return this.db.lead.count({
            where: { ownerId, mergedIntoId: null, anonymisedAt: null, lifecycleStage: { notIn: ['ENROLLED', 'LEARNER_ONBOARDED'] } },
        });
    }

    /** The lead if this person may see it: its id, owner and contact stage. */
    findMarkable(publicId: string, scope: LeadScope) {
        return this.db.lead.findFirst({
            where: { AND: [this.scopeWhere(scope), { publicId }] },
            select: { id: true, lifecycleStage: true, ownerId: true, doNotContact: true },
        });
    }

    /** Flips the flag only if it differs, so a repeat click changes nothing. Returns whether it changed. */
    async setDoNotContact(leadId: bigint, value: boolean): Promise<boolean> {
        const { count } = await this.db.lead.updateMany({ where: { id: leadId, doNotContact: !value }, data: { doNotContact: value } });
        return count === 1;
    }

    /** The phones (last 10 digits) and emails (lower case) that belong to a do-not-contact lead. */
    async findSuppressed(phones: string[], emails: string[]): Promise<{ phones: string[]; emails: string[] }> {
        const or: Prisma.LeadWhereInput[] = [];
        if (phones.length) or.push({ phoneLast10: { in: phones } });
        if (emails.length) or.push({ email: { in: emails } });
        if (!or.length) return { phones: [], emails: [] };
        const rows = await this.db.lead.findMany({ where: { doNotContact: true, OR: or }, select: { phoneLast10: true, email: true } });
        const p = new Set(phones);
        const e = new Set(emails);
        return {
            phones: [...new Set(rows.map((r) => r.phoneLast10).filter((v): v is string => !!v && p.has(v)))],
            emails: [...new Set(rows.map((r) => r.email?.toLowerCase()).filter((v): v is string => !!v && e.has(v)))],
        };
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

    /**
     * Notes that someone worked the lead: the first and last touch, and the count of attempts since the
     * last connected call (a connected call resets it, an unanswered attempt adds one). Returns the new count.
     */
    async recordTouch(
        leadId: bigint,
        at: Date,
        change: { connected: boolean | null; countsAsAttempt: boolean },
    ): Promise<number> {
        return this.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`;
            const lead = await tx.lead.findUniqueOrThrow({
                where: { id: leadId },
                select: { attemptCount: true, firstTouchAt: true, lastActivityAt: true },
            });
            const attemptCount = change.connected === true ? 0 : change.countsAsAttempt ? lead.attemptCount + 1 : lead.attemptCount;
            await tx.lead.update({
                where: { id: leadId },
                data: {
                    attemptCount,
                    firstTouchAt: lead.firstTouchAt ?? at,
                    lastActivityAt: lead.lastActivityAt && lead.lastActivityAt > at ? lead.lastActivityAt : at,
                },
            });
            return attemptCount;
        });
    }

    /** Leads that first reached the CRM in [from, to). Merged-away duplicates are not people. */
    countCaptured(from: Date, to: Date): Promise<number> {
        return this.db.lead.count({ where: { capturedAt: { gte: from, lt: to }, mergedIntoId: null } });
    }

    async setNextFollowup(leadId: bigint, at: Date | null): Promise<void> {
        await this.db.lead.update({ where: { id: leadId }, data: { nextFollowupAt: at } });
    }

    /** Sets the temperature by hand and keeps the call order in step. Returns the old value, or undefined when nothing changed. */
    async updateTemperature(leadId: bigint, temperature: TemperatureName): Promise<TemperatureName | null | undefined> {
        return this.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`;
            const lead = await tx.lead.findUnique({
                where: { id: leadId },
                select: { vslDepth: true, formScore: true, temperature: true },
            });
            if (!lead || lead.temperature === temperature) return undefined;
            await tx.lead.update({
                where: { id: leadId },
                data: { temperature, priorityRank: priorityRankOf(lead.vslDepth, temperature, lead.formScore) },
            });
            return lead.temperature;
        });
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

    // ---- automatic lists and hand-over ----

    findListByPublicId(
        publicId: string,
    ): Promise<(LeadListRecord & { createdById: bigint; originRef: string | null }) | null> {
        return this.db.leadList.findUnique({
            where: { publicId },
            select: { id: true, publicId: true, name: true, createdById: true, originRef: true },
        });
    }

    /**
     * Lists made by the system (their origin ref starts with `originPrefix`), newest first, with
     * how many leads each has and how many of those are still with the person they were created for.
     */
    async listBatches(originPrefix: string, take: number): Promise<BatchRow[]> {
        const lists = await this.db.leadList.findMany({
            where: { originRef: { startsWith: originPrefix } },
            orderBy: { createdAt: 'desc' },
            take,
            select: { id: true, publicId: true, name: true, createdAt: true, createdById: true },
        });
        return Promise.all(
            lists.map(async (list) => {
                const [total, waiting] = await Promise.all([
                    this.db.leadListMember.count({ where: { listId: list.id } }),
                    this.db.lead.count({
                        where: {
                            ownerId: list.createdById,
                            mergedIntoId: null,
                            listMembers: { some: { listId: list.id } },
                        },
                    }),
                ]);
                return {
                    publicId: list.publicId,
                    name: list.name,
                    createdAt: list.createdAt,
                    ownerId: list.createdById,
                    total,
                    waiting,
                };
            }),
        );
    }

    private static readonly ASSIGNABLE = {
        id: true,
        publicId: true,
        ownerId: true,
        firstSourceId: true,
        vslDepth: true,
        temperature: true,
    } as const;

    // ---- the Assignment queue ----

    /** Leads waiting for someone: no owner, still in play, and fine to contact. */
    private static readonly QUEUE_WHERE: Prisma.LeadWhereInput = {
        ownerId: null,
        mergedIntoId: null,
        anonymisedAt: null,
        doNotContact: false,
        lifecycleStage: { in: ['MARKETING_LEAD', 'ENGAGED_LEAD', 'PROSPECT'] },
    };

    private static readonly QUEUE_ORDER: Prisma.LeadOrderByWithRelationInput[] = [
        { priorityRank: 'desc' },
        { capturedAt: 'asc' },
        { id: 'asc' },
    ];

    /** The waiting leads, best first (booked call, then form, then details; warmer first; longest waiting first). */
    async queue(filters: QueueFilters, now: Date, matchingCap: number): Promise<QueueRows> {
        const hours = (n: number) => new Date(now.getTime() - n * 3_600_000);
        const where: Prisma.LeadWhereInput = {
            AND: [
                LeadsRepository.QUEUE_WHERE,
                filters.tab === 'booked' ? { vslDepth: 'BOOKED' } : filters.tab === 'hot' ? { temperature: 'HOT' } : {},
                filters.sourceId !== undefined ? { firstSourceId: filters.sourceId } : {},
                filters.depth ? { vslDepth: filters.depth } : {},
                filters.temperature ? { temperature: filters.temperature } : {},
                filters.wait === 'lt6'
                    ? { capturedAt: { gt: hours(6) } }
                    : filters.wait === '6to24'
                      ? { capturedAt: { lte: hours(6), gt: hours(24) } }
                      : filters.wait === 'gt24'
                        ? { capturedAt: { lte: hours(24) } }
                        : {},
            ],
        };
        const [items, matching, total, all, booked, hot, sources] = await Promise.all([
            this.db.lead.findMany({
                where,
                orderBy: LeadsRepository.QUEUE_ORDER,
                take: filters.limit,
                select: {
                    publicId: true,
                    fullName: true,
                    email: true,
                    currentCompany: true,
                    domain: true,
                    vslDepth: true,
                    temperature: true,
                    capturedAt: true,
                    firstSource: { select: { id: true, name: true } },
                    opportunities: { where: { status: 'OPEN' }, select: { scheduledCallAt: true }, take: 1 },
                },
            }),
            this.db.lead.findMany({ where, orderBy: LeadsRepository.QUEUE_ORDER, take: matchingCap, select: { publicId: true } }),
            this.db.lead.count({ where }),
            this.db.lead.count({ where: LeadsRepository.QUEUE_WHERE }),
            this.db.lead.count({ where: { AND: [LeadsRepository.QUEUE_WHERE, { vslDepth: 'BOOKED' }] } }),
            this.db.lead.count({ where: { AND: [LeadsRepository.QUEUE_WHERE, { temperature: 'HOT' }] } }),
            this.db.lead.findMany({
                where: LeadsRepository.QUEUE_WHERE,
                distinct: ['firstSourceId'],
                select: { firstSource: { select: { id: true, name: true } } },
            }),
        ]);
        return {
            items: items.map(({ opportunities, ...lead }) => ({ ...lead, scheduledCallAt: opportunities[0]?.scheduledCallAt ?? null })),
            matchingIds: matching.map((m) => m.publicId),
            total,
            counts: { all, booked, hot },
            sources: sources.map((s) => s.firstSource).sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    /** How many leads are waiting for someone (the Assignment pill in the sidebar). */
    countQueue(): Promise<number> {
        return this.db.lead.count({ where: LeadsRepository.QUEUE_WHERE });
    }

    /** How many leads in play each of these people owns. */
    async ownerLoads(ownerIds: bigint[]): Promise<OwnerLoadRow[]> {
        if (ownerIds.length === 0) return [];
        const rows = await this.db.lead.groupBy({
            by: ['ownerId'],
            where: {
                ownerId: { in: ownerIds },
                mergedIntoId: null,
                anonymisedAt: null,
                lifecycleStage: { in: ['MARKETING_LEAD', 'ENGAGED_LEAD', 'PROSPECT'] },
            },
            _count: { _all: true },
        });
        return rows.flatMap((r) => (r.ownerId === null ? [] : [{ ownerId: r.ownerId, open: r._count._all }]));
    }

    /** Members of a list that are owned by this person right now. */
    findListLeadsOwnedBy(listId: bigint, ownerId: bigint): Promise<AssignableLead[]> {
        return this.db.lead.findMany({
            where: { ownerId, mergedIntoId: null, listMembers: { some: { listId } } },
            select: LeadsRepository.ASSIGNABLE,
            orderBy: { id: 'asc' },
        });
    }

    findAssignableByPublicIds(publicIds: string[]): Promise<AssignableLead[]> {
        return this.db.lead.findMany({
            where: { publicId: { in: publicIds }, mergedIntoId: null },
            select: LeadsRepository.ASSIGNABLE,
        });
    }

    /**
     * Gives these leads to `toOwnerId`, but only those still owned by who we read them from, so a
     * change someone else made a moment ago is not overwritten. Returns the ids that moved.
     */
    async reassignOwner(
        moves: { id: bigint; fromOwnerId: bigint | null }[],
        toOwnerId: bigint,
    ): Promise<bigint[]> {
        const moved: bigint[] = [];
        // One update per previous owner: few owners, many leads.
        const byOwner = new Map<string, { from: bigint | null; ids: bigint[] }>();
        for (const move of moves) {
            const key = String(move.fromOwnerId);
            const group = byOwner.get(key) ?? { from: move.fromOwnerId, ids: [] };
            group.ids.push(move.id);
            byOwner.set(key, group);
        }
        for (const group of byOwner.values()) {
            for (let i = 0; i < group.ids.length; i += 500) {
                const chunk = group.ids.slice(i, i + 500);
                await this.db.$transaction(async (tx) => {
                    const current = await tx.lead.findMany({
                        where: { id: { in: chunk }, ownerId: group.from },
                        select: { id: true },
                    });
                    const ids = current.map((row) => row.id);
                    if (ids.length === 0) return;
                    await tx.lead.updateMany({ where: { id: { in: ids } }, data: { ownerId: toOwnerId } });
                    moved.push(...ids);
                });
            }
        }
        return moved;
    }


    // ---- the VSL: how far a person got ----

    async getVslState(leadId: bigint): Promise<VslState | null> {
        const row = await this.db.lead.findUnique({
            where: { id: leadId },
            select: { id: true, lifecycleStage: true, ownerId: true, vslDepth: true, formScore: true, temperature: true },
        });
        return row ? { ...row, leadId: row.id } : null;
    }

    /**
     * Moves how far a person got, never backwards, and keeps the latest form score and temperature.
     * The call order (priority rank) is recomputed from the result. Safe to repeat and safe when
     * events arrive out of order: a later step is not undone by an earlier one that arrives late.
     */
    async applyVslProgress(
        leadId: bigint,
        progress: { depth: VslDepthName; formScore?: number | null; temperature?: TemperatureName | null },
    ): Promise<void> {
        await this.db.$transaction(async (tx) => {
            // Two steps of the same person (the form and the booking, sent a moment apart) are processed at the same
            // time by different workers. Locking the row makes the second wait for the first, so neither overwrites
            // the other's result with the state it read before.
            await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`;
            const lead = await tx.lead.findUnique({
                where: { id: leadId },
                select: { vslDepth: true, formScore: true, temperature: true },
            });
            if (!lead) return;
            const depth = depthWeight(progress.depth) > depthWeight(lead.vslDepth) ? progress.depth : lead.vslDepth;
            const formScore = progress.formScore !== undefined ? progress.formScore : lead.formScore;
            const temperature = progress.temperature !== undefined ? progress.temperature : lead.temperature;
            await tx.lead.update({
                where: { id: leadId },
                data: { vslDepth: depth, formScore, temperature, priorityRank: priorityRankOf(depth, temperature, formScore) },
            });
        });
    }

    /** Keeps the answers of one form submission. False when this submission was already saved. */
    async saveFormResponse(input: FormResponseInput): Promise<boolean> {
        try {
            await this.db.formResponse.create({
                data: {
                    leadId: input.leadId,
                    formSlug: input.formSlug,
                    submissionRef: input.submissionRef,
                    score: input.score,
                    temperature: input.temperature,
                    answers: input.answers as unknown as Prisma.InputJsonValue,
                    submittedAt: input.submittedAt,
                },
            });
            return true;
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            return false;
        }
    }

    /** Keeps a booked call. False when this booking was already saved. */
    async saveBooking(input: BookingInput): Promise<boolean> {
        try {
            await this.db.booking.create({
                data: {
                    leadId: input.leadId,
                    bookingRef: input.bookingRef,
                    submissionRef: input.submissionRef,
                    slotStartAt: input.slotStartAt,
                    slotLabel: input.slotLabel,
                    status: 'CONFIRMED',
                },
            });
            return true;
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            return false;
        }
    }

    findBookingByRef(bookingRef: string): Promise<BookingRow | null> {
        return this.db.booking.findUnique({
            where: { bookingRef },
            select: { id: true, leadId: true, status: true, slotStartAt: true, slotLabel: true },
        });
    }

    /** True when this call changed the booking; false when it was already completed. */
    async completeBooking(bookingRef: string, completedAt: Date): Promise<boolean> {
        const { count } = await this.db.booking.updateMany({
            where: { bookingRef, status: 'CONFIRMED' },
            data: { status: 'COMPLETED', completedAt },
        });
        return count === 1;
    }

    /** True when this call cancelled the booking; false when it was not confirmed (already cancelled, or already done). */
    async cancelBooking(bookingRef: string, cancelledAt: Date, source: string | null): Promise<boolean> {
        const { count } = await this.db.booking.updateMany({
            where: { bookingRef, status: 'CONFIRMED' },
            data: { status: 'CANCELLED', cancelledAt, cancelSource: source ? source.slice(0, 30) : null },
        });
        return count === 1;
    }

    /** True when the call moved to a different time. Only a confirmed booking can move. */
    async rescheduleBooking(bookingRef: string, slotStartAt: Date, slotLabel: string): Promise<boolean> {
        const { count } = await this.db.booking.updateMany({
            where: { bookingRef, status: 'CONFIRMED', OR: [{ slotStartAt: { not: slotStartAt } }, { slotLabel: { not: slotLabel } }] },
            data: { slotStartAt, slotLabel },
        });
        return count === 1;
    }

    /** The VSL team un-marked a call as done: back to confirmed. False when it was not completed. */
    async reopenBooking(bookingRef: string, reopenedAt: Date | null): Promise<boolean> {
        const { count } = await this.db.booking.updateMany({
            where: { bookingRef, status: 'COMPLETED', ...(reopenedAt ? { completedAt: { lte: reopenedAt } } : {}) },
            data: { status: 'CONFIRMED', completedAt: null },
        });
        return count === 1;
    }

    /**
     * The time of the call the lead is waiting for: the earliest confirmed one still ahead, or when all are
     * behind us the latest confirmed one (a call nobody has marked done yet). Null with no confirmed booking.
     */
    async nextConfirmedSlot(leadId: bigint, now: Date): Promise<Date | null> {
        const ahead = await this.db.booking.findFirst({
            where: { leadId, status: 'CONFIRMED', slotStartAt: { gte: now } },
            orderBy: { slotStartAt: 'asc' },
            select: { slotStartAt: true },
        });
        if (ahead) return ahead.slotStartAt;
        const behind = await this.db.booking.findFirst({
            where: { leadId, status: 'CONFIRMED' },
            orderBy: { slotStartAt: 'desc' },
            select: { slotStartAt: true },
        });
        return behind?.slotStartAt ?? null;
    }

    /**
     * Sets how far a person got from what the CRM actually holds, which unlike applyVslProgress can move it back:
     * a cancelled booking is no longer a booked call. Booked if any booking is confirmed or done, else form if a
     * form was filled, else details (a person who never reached the VSL stays at none).
     */
    async settleVslDepth(leadId: bigint): Promise<void> {
        await this.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`;
            const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { vslDepth: true, formScore: true, temperature: true } });
            if (!lead) return;
            const [live, forms] = await Promise.all([
                tx.booking.count({ where: { leadId, status: { in: ['CONFIRMED', 'COMPLETED'] } } }),
                tx.formResponse.count({ where: { leadId } }),
            ]);
            const depth: VslDepthName = live > 0 ? 'BOOKED' : forms > 0 ? 'FORM' : lead.vslDepth === 'NONE' ? 'NONE' : 'DETAILS';
            if (depth === lead.vslDepth) return;
            await tx.lead.update({
                where: { id: leadId },
                data: { vslDepth: depth, priorityRank: priorityRankOf(depth, lead.temperature, lead.formScore) },
            });
        });
    }

    /**
     * The VSL header-score rule. A lead who filled the qualification form carries the form's score (0 to 100) as
     * its lead score, from the newest form. The ledger gets one entry for the change, so it keeps adding up, and any
     * points given for other reasons stay on top. An older form arriving late changes nothing. Returns the
     * change in points (0 when nothing changed).
     */
    /** Whether the team has tried this lead: a call, WhatsApp or email, answered or not. A note does not count. */
    async hasOutreach(leadId: bigint): Promise<boolean> {
        return (await this.db.activity.findFirst({ where: { leadId, kind: { not: 'NOTE' } }, select: { id: true } })) !== null;
    }

    /** One lead's timeline events of the given types, in the order they were written. */
    async timelineEventsOf(leadId: bigint, types: string[]): Promise<Array<{ type: string; data: Record<string, unknown> | null }>> {
        const rows = await this.db.leadEvent.findMany({ where: { leadId, type: { in: types } }, orderBy: { id: 'asc' }, select: { type: true, data: true } });
        return rows.map((r) => ({ type: r.type, data: r.data !== null && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : null }));
    }

    /** The score of the lead's newest filled form that has one. */
    async newestScoredFormOf(leadId: bigint): Promise<{ submissionRef: string; score: number } | null> {
        const form = await this.db.formResponse.findFirst({ where: { leadId }, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], select: { submissionRef: true, score: true } });
        return form && form.score !== null ? { submissionRef: form.submissionRef, score: form.score } : null;
    }

    /**
     * Takes back the VSL points of leads nobody has tried yet (details, booked slot, form score), so they wait for the
     * first attempt. For leads scored before that rule. Returns how many leads changed.
     */
    async holdVslPoints(reasons: string[]): Promise<number> {
        return this.db.$transaction(async (tx) => {
            await tx.$executeRaw`
                DELETE FROM lead_score_entries
                WHERE reason IN (${Prisma.join(reasons)})
                  AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = lead_score_entries.lead_id AND a.kind <> 'NOTE')`;
            return tx.$executeRaw`
                UPDATE leads l
                SET l.lead_score = (SELECT COALESCE(SUM(e.points), 0) FROM lead_score_entries e WHERE e.lead_id = l.id)
                WHERE NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.kind <> 'NOTE')
                  AND l.lead_score <> (SELECT COALESCE(SUM(e.points), 0) FROM lead_score_entries e WHERE e.lead_id = l.id)`;
        });
    }

    /**
     * Adds points for a score rule unless this lead already has them for the same reason and ref. Returns the points
     * added (0 when they were already there, or the lead is gone). Locks the lead row first, as addScore does.
     */
    async awardScoreOnce(data: { leadId: bigint; points: number; reason: string; ref: string; now: Date }): Promise<number> {
        return this.db.$transaction(async (tx) => {
            const locked = await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM leads WHERE id = ${data.leadId} FOR UPDATE`;
            if (locked.length === 0) return 0;
            const seen = await tx.leadScoreEntry.findFirst({ where: { leadId: data.leadId, reason: data.reason, ref: data.ref }, select: { id: true } });
            if (seen) return 0;
            await tx.lead.update({ where: { id: data.leadId }, data: { leadScore: { increment: data.points }, scoreUpdatedAt: data.now } });
            await tx.leadScoreEntry.create({ data: { leadId: data.leadId, points: data.points, reason: data.reason, ref: data.ref, createdAt: data.now } });
            return data.points;
        });
    }

    /**
     * Claims a one-time job by writing its settings key. True for the one caller that wrote it; false when it was
     * already there (done before, or another process got there first).
     */
    async claimOnce(key: string): Promise<boolean> {
        try {
            await this.db.appSetting.create({ data: { key, value: { at: new Date().toISOString() } } });
            return true;
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
            throw error;
        }
    }

    /** Whether a logged call connected (null when it is not a call or is gone). */
    async activityConnected(activityId: bigint): Promise<boolean | null> {
        return (await this.db.activity.findUnique({ where: { id: activityId }, select: { connected: true } }))?.connected ?? null;
    }

    /** Timeline events in the order they were written, for a score recalculation. */
    async timelineEventsAfter(afterId: bigint, take: number): Promise<Array<{ id: bigint; leadId: bigint; type: string; data: Record<string, unknown> | null }>> {
        const rows = await this.db.leadEvent.findMany({
            where: { id: { gt: afterId } },
            orderBy: { id: 'asc' },
            take,
            select: { id: true, leadId: true, type: true, data: true },
        });
        return rows.map((r) => ({ ...r, data: r.data !== null && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : null }));
    }

    /** Each lead's newest filled form that has a score. */
    async newestScoredForms(): Promise<Array<{ leadId: bigint; submissionRef: string; score: number }>> {
        const rows = await this.db.formResponse.findMany({
            orderBy: [{ leadId: 'asc' }, { submittedAt: 'desc' }, { id: 'desc' }],
            select: { leadId: true, submissionRef: true, score: true },
        });
        const newest = new Map<bigint, { leadId: bigint; submissionRef: string; score: number | null }>();
        for (const r of rows) if (!newest.has(r.leadId)) newest.set(r.leadId, r);
        return [...newest.values()].flatMap((r) => (r.score === null ? [] : [{ leadId: r.leadId, submissionRef: r.submissionRef, score: r.score }]));
    }

    async applyFormScore(leadId: bigint, submissionRef: string, score: number, now: Date): Promise<number> {
        return this.db.$transaction(async (tx) => {
            // Locks the lead row first, as addScore does, so two scores queue up rather than deadlock.
            await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId} FOR UPDATE`;
            const locked = await tx.lead.findUnique({ where: { id: leadId }, select: { leadScore: true } });
            if (!locked) return 0;
            const newest = await tx.formResponse.findFirst({ where: { leadId }, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], select: { submissionRef: true } });
            if (newest && newest.submissionRef !== submissionRef) return 0;
            const prior = await tx.leadScoreEntry.aggregate({ where: { leadId, reason: FORM_SCORE_REASON }, _sum: { points: true } });
            const delta = score - (prior._sum.points ?? 0);
            if (delta === 0) return 0;
            await tx.lead.update({ where: { id: leadId }, data: { leadScore: locked.leadScore + delta, scoreUpdatedAt: now } });
            await tx.leadScoreEntry.create({ data: { leadId, points: delta, reason: FORM_SCORE_REASON, ref: `vsl:form:${submissionRef}`.slice(0, 100), createdAt: now } });
            return delta;
        });
    }

    /** Bookings the nightly check looks at: every confirmed one, and any that changed since `since`. */
    listBookingsToCheck(since: Date, take: number): Promise<BookingCheckRow[]> {
        return this.db.booking.findMany({
            where: { OR: [{ status: 'CONFIRMED' }, { updatedAt: { gte: since } }] },
            orderBy: { id: 'asc' },
            take,
            select: { bookingRef: true, leadId: true, status: true, slotStartAt: true, slotLabel: true, lead: { select: { ownerId: true, lifecycleStage: true } } },
        }).then((rows) => rows.map(({ lead, ...row }) => ({ ...row, ownerId: lead.ownerId, lifecycleStage: lead.lifecycleStage })));
    }

    /** The VSL part of the lead page: filled forms (newest first) and booked calls. */
    async vslSummary(leadId: bigint): Promise<VslSummaryRow> {
        const [forms, bookings] = await Promise.all([
            this.db.formResponse.findMany({
                where: { leadId },
                orderBy: { submittedAt: 'desc' },
                take: 5,
                select: { formSlug: true, score: true, temperature: true, answers: true, submittedAt: true },
            }),
            this.db.booking.findMany({
                where: { leadId },
                orderBy: { slotStartAt: 'desc' },
                take: 5,
                select: { slotStartAt: true, slotLabel: true, status: true, completedAt: true },
            }),
        ]);
        return { forms, bookings };
    }

    async namesByIds(ids: bigint[]): Promise<Map<bigint, { name: string; publicId: string }>> {
        if (ids.length === 0) return new Map();
        const rows = await this.db.lead.findMany({
            where: { id: { in: ids } },
            select: { id: true, fullName: true, publicId: true },
        });
        return new Map(rows.map((r) => [r.id, { name: r.fullName, publicId: r.publicId }]));
    }
}
