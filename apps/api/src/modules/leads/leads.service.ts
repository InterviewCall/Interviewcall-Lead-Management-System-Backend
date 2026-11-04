import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { IamService } from '@modules/iam';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { LeadsRepository } from './leads.repository.js';
import type {
    CustomFieldView,
    IdentityKey,
    ImportedLeadFields,
    ImportLeadInput,
    ImportLeadOutcome,
    LeadDetailRow,
    LeadListRecord,
    LeadListRow,
    LeadMatch,
    LeadScope,
    LeadSearch,
    LeadSourceView,
} from './leads.types.js';

export const identityKeysOf = (
    fields: Pick<ImportedLeadFields, 'email' | 'phoneLast10'>,
): IdentityKey[] => {
    const keys: IdentityKey[] = [];
    if (fields.email) keys.push({ type: 'EMAIL', value: fields.email });
    if (fields.phoneLast10) keys.push({ type: 'PHONE', value: fields.phoneLast10 });
    return keys;
};

/** The key a match is stored under in the map `findMatches` returns. */
export const identityMapKey = (key: IdentityKey) => `${key.type}:${key.value}`;

/** Roles that may change a lead's contact stage. */
const MARKING_ROLES: readonly string[] = ['ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER'];
/** Learner Onboarded belongs to the people who onboard, not to the BDA who sold. */
const ONBOARDING_ROLES: readonly string[] = ['ADMIN', 'SALES_MANAGER', 'CLOSER', 'OPS'];

@Injectable()
export class LeadsService {
    constructor(
        private readonly repository: LeadsRepository,
        private readonly iam: IamService,
        private readonly timeline: TimelineService,
    ) {}

    // ---- sources and custom fields ----

    listSources(): Promise<LeadSourceView[]> {
        return this.repository.listActiveSources();
    }

    findActiveSource(id: number): Promise<LeadSourceView | null> {
        return this.repository.findActiveSource(id);
    }

    listCustomFields(): Promise<CustomFieldView[]> {
        return this.repository.listCustomFields();
    }

    /** Makes any of these text fields that do not exist yet. Existing fields are left alone. */
    ensureCustomFields(fields: CustomFieldView[]): Promise<void> {
        return this.repository.ensureCustomFields(fields);
    }

    // ---- lists ----

    /** True when no list has this name (names are compared without regard to case). */
    async isListNameFree(name: string, originRef?: string): Promise<boolean> {
        const existing = await this.repository.findListByName(name);
        return existing === null || (originRef !== undefined && existing.originRef === originRef);
    }

    /**
     * Makes the list an import adds its leads to. Safe to call again for the same `originRef`: the
     * list that call made is returned. A list with the same name made by anything else is a
     * conflict.
     */
    async createList(data: {
        name: string;
        description: string | null;
        originRef: string;
        createdById: bigint;
    }): Promise<LeadListRecord> {
        const already = await this.repository.findListByOriginRef(data.originRef);
        if (already) return already;
        try {
            return await this.repository.createList(data);
        } catch (error) {
            if (!this.repository.isUniqueConflict(error)) throw error;
            // Either another attempt of this same job got there first, or the name is taken.
            const raced = await this.repository.findListByOriginRef(data.originRef);
            if (raced) return raced;
            throw new ConflictException({
                code: 'LIST_NAME_TAKEN',
                message: 'A list with this name already exists. Choose another name.',
                fields: { listName: 'A list with this name already exists' },
            });
        }
    }

    // ---- matching and importing ----

    /** Leads already holding these identities, keyed by `identityMapKey`. */
    findMatches(identities: IdentityKey[]): Promise<Map<string, LeadMatch>> {
        return this.repository.findByIdentities(identities);
    }

    /**
     * Puts one imported row through the same matching every lead source uses: the email and the
     * phone are looked up in lead_identities, and a person who is already there is never created
     * again. The database's unique index on (type, value) is the final guard, so two imports (or
     * an import and a live signup) racing on the same person still end with one lead.
     */
    async importLead(input: ImportLeadInput): Promise<ImportLeadOutcome> {
        const duplicateRef = `${input.ref}:dup`;
        const keys = identityKeysOf(input.fields);
        if (keys.length === 0) {
            throw new Error('importLead needs an email or a phone');
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            // An earlier attempt at this very row may already have handled it.
            const earlier = await this.repository.findTouchpointLeads([input.ref, duplicateRef]);
            const createdLead = earlier.get(input.ref);
            if (createdLead !== undefined) {
                return { kind: 'CREATED', leadId: createdLead, resumed: true };
            }
            const duplicateLead = earlier.get(duplicateRef);
            if (duplicateLead !== undefined) {
                const match = await this.repository.findLeadMatchById(duplicateLead);
                if (match) return { kind: 'MATCHED', match, matchedOn: [], filled: [], resumed: true };
            }

            const found = await this.repository.findByIdentities(keys);
            const distinct = new Map<bigint, LeadMatch>();
            for (const match of found.values()) distinct.set(match.leadId, match);
            const matches = [...distinct.values()];

            if (matches.length > 1) {
                return { kind: 'CONFLICT', first: matches[0], second: matches[1] };
            }
            const now = new Date();
            if (matches.length === 1) {
                const match = matches[0];
                const matchedOn = keys
                    .filter((key) => found.get(identityMapKey(key))?.leadId === match.leadId)
                    .map((key) => key.type);
                // The person came in again: remember where from, whichever way duplicates are handled.
                await this.repository.addImportTouchpoint({
                    leadId: match.leadId,
                    sourceId: input.sourceId,
                    ref: duplicateRef,
                    payload: { ...input.touchpointPayload, duplicate: true },
                    now,
                });
                const filled =
                    input.handling === 'FILL_EMPTY'
                        ? await this.repository.fillEmptyFields(match.leadId, input.fields)
                        : [];
                return { kind: 'MATCHED', match, matchedOn, filled, resumed: false };
            }

            try {
                const leadId = await this.repository.createImportedLead({
                    fields: input.fields,
                    sourceId: input.sourceId,
                    ownerId: input.ownerId,
                    listId: input.listId,
                    ref: input.ref,
                    initialScore: input.initialScore,
                    touchpointPayload: input.touchpointPayload,
                    now,
                });
                return { kind: 'CREATED', leadId, resumed: false };
            } catch (error) {
                // Somebody else created this person between our lookup and our insert. Look again.
                if (!this.repository.isUniqueConflict(error)) throw error;
            }
        }
        throw new Error('Could not settle whether this person is already a lead');
    }

    // ---- score ----

    /**
     * Moves a lead's score by `points` (negative to lower it) and records why. Returns the new
     * total. This is the one place the score changes, so the ledger always adds up.
     */
    async addScore(
        leadId: bigint,
        points: number,
        reason: string,
        ref: string | null = null,
    ): Promise<number> {
        if (!Number.isInteger(points) || points === 0) {
            throw new RangeError('points must be a non-zero whole number');
        }
        if (reason.trim() === '' || reason.length > 60) {
            throw new RangeError('reason must be 1 to 60 characters');
        }
        return this.repository.addScore({
            leadId,
            points,
            reason,
            ref: ref ? ref.slice(0, 100) : null,
            now: new Date(),
        });
    }

    // ---- reading leads ----

    /** What this person may see: a BDA their own leads, a closer leads in play, everyone else all. */
    private scopeFor(auth: AuthContext): LeadScope {
        if (auth.role === 'BDA') return { kind: 'OWNED_BY', staffPublicId: auth.publicId };
        if (auth.role === 'CLOSER') return { kind: 'OPEN_OPPORTUNITY' };
        return { kind: 'ALL' };
    }

    async listLeads(auth: AuthContext, query: Omit<LeadSearch, 'scope' | 'me' | 'skip' | 'take'> & { page: number; pageSize: number }) {
        const scope = this.scopeFor(auth);
        const { page, pageSize, ...filters } = query;
        const [{ rows, total }, counts] = await Promise.all([
            this.repository.searchLeads({
                ...filters,
                scope,
                me: auth.publicId,
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.repository.countViews(scope, auth.publicId),
        ]);
        return { leads: rows.map(toLeadView), total, page, pageSize, counts };
    }

    /** Sources, owners and lists for the filters on the leads screen. */
    async leadFilters(auth: AuthContext) {
        const scope = this.scopeFor(auth);
        const [sources, lists, owners] = await Promise.all([
            this.repository.listActiveSources(),
            this.repository.listLeadLists(scope),
            scope.kind === 'ALL' ? this.repository.listLeadOwners() : Promise.resolve([]),
        ]);
        return { sources, lists, owners };
    }

    // ---- marking ----

    /** The lead's internal id, if this person may see it. Used before any change to a lead. */
    async resolveForMarking(auth: AuthContext, publicId: string) {
        const lead = await this.repository.findMarkable(publicId, this.scopeFor(auth));
        if (!lead) {
            throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'This lead does not exist or you cannot open it' });
        }
        return lead;
    }

    /**
     * Sets the contact stage (the lifecycle) by hand. The handbook's rules are enforced here:
     *  - Enrolled only follows a Closed-Won opportunity, so it cannot be picked directly.
     *  - Learner Onboarded follows Enrolled and belongs to the people who onboard.
     *  - Moving back out of Enrolled or Learner Onboarded is a correction for managers.
     */
    async setContactStage(auth: AuthContext, publicId: string, stage: string) {
        const lead = await this.resolveForMarking(auth, publicId);
        const from = lead.lifecycleStage as string;
        if (from === stage) return this.getLead(auth, publicId, { afterMarking: true });

        const deny = (message: string) => {
            throw new ForbiddenException({ code: 'CONTACT_STAGE_NOT_ALLOWED', message });
        };
        if (!(stage === 'LEARNER_ONBOARDED' ? ONBOARDING_ROLES : MARKING_ROLES).includes(auth.role)) {
            deny('Your role cannot change the contact stage');
        }
        if (stage === 'ENROLLED') {
            throw new ConflictException({
                code: 'ENROLL_VIA_CLOSED_WON',
                message: 'A lead becomes Enrolled when its opportunity is moved to Closed Won, after payment or financing is complete',
            });
        }
        if (stage === 'LEARNER_ONBOARDED') {
            if (from !== 'ENROLLED') {
                throw new ConflictException({ code: 'ONBOARD_AFTER_ENROLLED', message: 'Only an Enrolled lead can be marked Learner Onboarded' });
            }
        } else if ((from === 'ENROLLED' || from === 'LEARNER_ONBOARDED') && !['ADMIN', 'SALES_MANAGER'].includes(auth.role)) {
            deny('Only an admin or sales manager can move an enrolled lead back');
        }
        await this.applyLifecycle(lead.id, from, stage, auth);
        return this.getLead(auth, publicId, { afterMarking: true });
    }

    /** Used when an opportunity is won: the contact stage becomes Enrolled. */
    async markEnrolled(leadId: bigint, actorId: bigint | null): Promise<void> {
        const lead = await this.repository.findLifecycle(leadId);
        if (!lead || lead.lifecycleStage === 'ENROLLED' || lead.lifecycleStage === 'LEARNER_ONBOARDED') return;
        await this.applyLifecycle(leadId, lead.lifecycleStage as string, 'ENROLLED', { actorId });
    }

    private async applyLifecycle(leadId: bigint, from: string, to: string, by: { actorId: bigint | null } | AuthContext) {
        const changed = await this.repository.updateLifecycle(leadId, from, to);
        if (!changed) {
            throw new ConflictException({ code: 'LEAD_CHANGED', message: 'Someone else just changed this lead. Reload it and try again' });
        }
        const actorId = 'actorId' in by ? by.actorId : ((await this.iam.getStaffRef(by.publicId))?.id ?? null);
        await this.timeline.append({
            leadId,
            type: TimelineEvent.ContactStageChanged,
            actorType: actorId === null ? 'SYSTEM' : 'USER',
            actorId,
            data: { from, to },
        });
    }

    /**
     * The lead page. `afterMarking` is for the answer to a change this person was allowed to
     * make: closing a lead takes it out of a closer's scope, but they still get to see the result.
     */
    async getLead(auth: AuthContext, publicId: string, options: { afterMarking?: boolean } = {}) {
        const scope: LeadScope = options.afterMarking ? { kind: 'ALL' } : this.scopeFor(auth);
        const row = await this.repository.findLeadDetail(publicId, scope);
        if (!row) {
            throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'This lead does not exist or you cannot open it' });
        }
        const [customFields, names] = await Promise.all([
            this.repository.listCustomFields(),
            this.iam.getStaffNames(row.events.flatMap((e) => (e.actorType === 'USER' && e.actorId !== null ? [e.actorId] : []))),
        ]);
        const owners = new Map<string, string>();
        for (const event of row.events) {
            const to = (event.data as { to?: unknown } | null)?.to;
            if (event.type === 'ASSIGNED' && typeof to === 'string' && !owners.has(to)) {
                const ref = await this.iam.getStaffRef(to);
                if (ref) owners.set(to, ref.name);
            }
        }
        const custom = (row.custom ?? {}) as Record<string, unknown>;
        const lists = new Map(row.listMembers.map((m) => [m.list.publicId, m.list.name]));
        return {
            lead: {
                ...toLeadView(row),
                company: row.currentCompany,
                ctc: row.currentCtc,
                graduationYear: row.graduationYear,
                domain: row.domain,
                userType: row.userType,
                doNotContact: row.doNotContact,
                lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
                lists: row.listMembers.map((m) => ({ id: m.list.publicId, name: m.list.name })),
                customFields: customFields
                    .filter((f) => custom[f.key] !== undefined && custom[f.key] !== null && custom[f.key] !== '')
                    .map((f) => ({ label: f.label, value: String(custom[f.key]) })),
            },
            opportunity: row.detailOpportunity
                ? {
                      stage: row.detailOpportunity.stage,
                      status: row.detailOpportunity.status,
                      openedAt: row.detailOpportunity.openedAt.toISOString(),
                      stageChangedAt: row.detailOpportunity.stageChangedAt.toISOString(),
                      closedAt: row.detailOpportunity.closedAt?.toISOString() ?? null,
                      lostReason: row.detailOpportunity.lostReason?.name ?? null,
                      lostNote: row.detailOpportunity.lostNote,
                  }
                : null,
            scoreEntries: row.scoreEntries.map((e) => ({
                id: String(e.id),
                points: e.points,
                reason: e.reason,
                at: e.createdAt.toISOString(),
            })),
            events: row.events.map((e) => describeEvent(e, names, owners, lists)),
        };
    }
}

// ---- views ----

function leadNext(row: LeadListRow): { kind: 'booked' | 'task' | 'none'; at: string | null } {
    const call = row.opportunities[0]?.status === 'OPEN' ? row.opportunities[0].scheduledCallAt : null;
    if (call) return { kind: 'booked', at: call.toISOString() };
    if (row.nextFollowupAt) return { kind: 'task', at: row.nextFollowupAt.toISOString() };
    return { kind: 'none', at: null };
}

export function toLeadView(row: LeadListRow) {
    const opportunity = row.opportunities[0] ?? null;
    return {
        id: row.publicId,
        name: row.fullName,
        email: row.email,
        phone: row.phoneE164,
        source: row.firstSource.name,
        sourceId: row.firstSource.id,
        lifecycle: row.lifecycleStage,
        stage: opportunity?.stage ?? null,
        opportunityStatus: opportunity?.status ?? null,
        temperature: row.temperature,
        score: row.leadScore,
        owner: row.owner ? { id: row.owner.publicId, name: row.owner.name } : null,
        next: leadNext(row),
        createdAt: row.capturedAt.toISOString(),
    };
}

const stageName = (value: unknown) =>
    typeof value === 'string'
        ? value.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        : '';

/** One sentence per kind of event. The events hold ids only; names are filled in here. */
export function describeEvent(
    event: LeadDetailRow['events'][number],
    staff: Map<bigint, string>,
    owners: Map<string, string>,
    lists: Map<string, string>,
) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const who = event.actorType === 'USER' && event.actorId !== null ? (staff.get(event.actorId) ?? 'A teammate') : event.actorType === 'SOURCE' ? 'A lead source' : 'The CRM';
    let title: string;
    let sub: string;
    switch (event.type) {
        case 'LEAD_CREATED': {
            const list = typeof data.list === 'string' ? lists.get(data.list) : undefined;
            title = data.importJob ? 'Lead created from a CSV import' : 'Lead created';
            sub = list ? `Added to the list “${list}” by ${who}` : `By ${who}`;
            break;
        }
        case 'TOUCHPOINT_ADDED':
            title = data.importJob ? 'Appeared again in a CSV import' : 'Came in again';
            sub = `Recorded by ${who}; nothing was overwritten`;
            break;
        case 'ASSIGNED': {
            const to = typeof data.to === 'string' ? owners.get(data.to) : undefined;
            title = to ? `Assigned to ${to}` : 'Assigned';
            sub = data.method === 'IMPORT' ? `By ${who} during an import` : `By ${who}`;
            break;
        }
        case 'OPPORTUNITY_OPENED':
            title = `Opportunity opened at ${stageName(data.stage) || 'the first stage'}`;
            sub = `By ${who}`;
            break;
        case 'CONTACT_STAGE_CHANGED':
            title = `Contact stage changed to ${stageName(data.to)}`;
            sub = `From ${stageName(data.from)} by ${who}`;
            break;
        case 'OPPORTUNITY_STAGE_CHANGED':
            title = `Moved to ${stageName(data.to)}`;
            sub = `From ${stageName(data.from)} by ${who}`;
            break;
        case 'OPPORTUNITY_WON':
            title = 'Opportunity won';
            sub = `Closed at ${stageName(data.stage)} by ${who}`;
            break;
        case 'OPPORTUNITY_LOST':
            title = typeof data.reason === 'string' ? `Marked lost: ${data.reason}` : 'Marked lost';
            sub = `At ${stageName(data.stage)} by ${who}`;
            break;
        default:
            title = stageName(event.type);
            sub = `By ${who}`;
    }
    return { id: String(event.id), type: event.type, title, sub, at: event.occurredAt.toISOString() };
}
