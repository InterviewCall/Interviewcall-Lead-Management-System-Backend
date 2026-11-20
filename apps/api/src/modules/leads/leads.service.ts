import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { IamService } from '@modules/iam';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { LeadsRepository } from './leads.repository.js';
import type { EditLeadBody } from './leads.schemas.js';
import { checkFieldValue } from './custom-fields.js';
import { toFieldView } from './custom-fields.service.js';
import { normaliseMobile } from './phone.js';
import type {
    AssignableLead,
    BatchRow,
    BulkResult,
    BoardFilters,
    BoardRows,
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
    BookingInput,
    BookingCheckRow,
    OwnerLoadRow,
    QueueFilters,
    QueueRows,
    BookingRow,
    EditableField,
    FormResponseInput,
    LeadDetailsPatch,
    LeadSourceRule,
    LeadSourceView,
    TemperatureName,
    VslDepthName,
    VslState,
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
/**
 * Runs one change per lead, one after another. A change that is refused (an HTTP error such as "only an Enrolled lead
 * can be onboarded" or "you cannot open this lead") skips that lead and is counted under its reason; anything else
 * is a real failure and stops the run.
 */
export async function runBulk(ids: string[], change: (id: string) => Promise<boolean>): Promise<BulkResult> {
    let done = 0;
    let unchanged = 0;
    const reasons = new Map<string, number>();
    for (const id of ids) {
        try {
            if (await change(id)) done += 1;
            else unchanged += 1;
        } catch (error) {
            if (!(error instanceof HttpException)) throw error;
            const body = error.getResponse();
            const reason = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : error.message;
            reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        }
    }
    return { done, unchanged, skipped: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}

const MARKING_ROLES: readonly string[] = ['ADMIN', 'SALES_MANAGER', 'BDA', 'CLOSER'];
/** Learner Onboarded belongs to the people who onboard, not to the BDA who sold. */
const ONBOARDING_ROLES: readonly string[] = ['ADMIN', 'SALES_MANAGER', 'CLOSER', 'OPS'];

@Injectable()
export class LeadsService {
    constructor(
        private readonly repository: LeadsRepository,
        private readonly iam: IamService,
        private readonly timeline: TimelineService,
        private readonly admin: AdminService,
    ) {}

    // ---- sources and custom fields ----

    listSources(): Promise<LeadSourceView[]> {
        return this.repository.listActiveSources();
    }

    /** The active sources with their matching rules, in the order the rules are tried. */
    listSourceRules(): Promise<LeadSourceRule[]> {
        return this.repository.listSourceRules();
    }

    // ---- the VSL ----

    getVslState(leadId: bigint): Promise<VslState | null> {
        return this.repository.getVslState(leadId);
    }

    applyVslProgress(
        leadId: bigint,
        progress: { depth: VslDepthName; formScore?: number | null; temperature?: TemperatureName | null },
    ): Promise<void> {
        return this.repository.applyVslProgress(leadId, progress);
    }

    saveFormResponse(input: FormResponseInput): Promise<boolean> {
        return this.repository.saveFormResponse(input);
    }

    saveBooking(input: BookingInput): Promise<boolean> {
        return this.repository.saveBooking(input);
    }

    findBookingByRef(bookingRef: string): Promise<BookingRow | null> {
        return this.repository.findBookingByRef(bookingRef);
    }

    completeBooking(bookingRef: string, completedAt: Date): Promise<boolean> {
        return this.repository.completeBooking(bookingRef, completedAt);
    }

    // ---- the Assignment queue ----

    /** The leads waiting for someone to take them, best first. */
    waitingQueue(filters: QueueFilters, now = new Date()): Promise<QueueRows> {
        return this.repository.queue(filters, now, 2000);
    }

    countWaiting(): Promise<number> {
        return this.repository.countQueue();
    }

    ownerLoads(ownerIds: bigint[]): Promise<OwnerLoadRow[]> {
        return this.repository.ownerLoads(ownerIds);
    }

    cancelBooking(bookingRef: string, cancelledAt: Date, source: string | null): Promise<boolean> {
        return this.repository.cancelBooking(bookingRef, cancelledAt, source);
    }

    rescheduleBooking(bookingRef: string, slotStartAt: Date, slotLabel: string): Promise<boolean> {
        return this.repository.rescheduleBooking(bookingRef, slotStartAt, slotLabel);
    }

    reopenBooking(bookingRef: string, reopenedAt: Date | null = null): Promise<boolean> {
        return this.repository.reopenBooking(bookingRef, reopenedAt);
    }

    /** The time of the call this lead is waiting for, or null with no confirmed booking. */
    nextConfirmedSlot(leadId: bigint, now = new Date()): Promise<Date | null> {
        return this.repository.nextConfirmedSlot(leadId, now);
    }

    /** Puts how far the person got back in line with their bookings and forms (a cancelled booking is not a booked call). */
    settleVslDepth(leadId: bigint): Promise<void> {
        return this.repository.settleVslDepth(leadId);
    }

    /**
     * The VSL header-score rule: the lead's score carries the newest form's score. Returns the change in points. Until the team
     * has tried the lead the form score is held back; the first attempt releases it (see ScoringService).
     */
    async applyFormScore(leadId: bigint, submissionRef: string, score: number, now = new Date()): Promise<number> {
        if (!(await this.repository.hasOutreach(leadId))) return 0;
        return this.repository.applyFormScore(leadId, submissionRef, score, now);
    }

    listBookingsToCheck(since: Date, take = 5000): Promise<BookingCheckRow[]> {
        return this.repository.listBookingsToCheck(since, take);
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
                    kind: input.kind,
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
                    kind: input.kind,
                    scoreReason: input.scoreReason,
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

    // ---- automatic lists and hand-over ----

    findListByPublicId(publicId: string) {
        return this.repository.findListByPublicId(publicId);
    }

    listBatches(originPrefix: string, take = 30): Promise<BatchRow[]> {
        return this.repository.listBatches(originPrefix, take);
    }

    findListLeadsOwnedBy(listId: bigint, ownerId: bigint): Promise<AssignableLead[]> {
        return this.repository.findListLeadsOwnedBy(listId, ownerId);
    }

    countCaptured(from: Date, to: Date): Promise<number> {
        return this.repository.countCaptured(from, to);
    }

    findAssignableByPublicIds(publicIds: string[]): Promise<AssignableLead[]> {
        return this.repository.findAssignableByPublicIds(publicIds);
    }

    /** Moves leads to a new owner, skipping any that changed hands since they were read. */
    reassignOwner(moves: { id: bigint; fromOwnerId: bigint | null }[], toOwnerId: bigint): Promise<bigint[]> {
        return this.repository.reassignOwner(moves, toOwnerId);
    }

    /** Names and public ids for these lead ids, for screens that list events. */
    leadNames(ids: bigint[]): Promise<Map<bigint, { name: string; publicId: string }>> {
        return this.repository.namesByIds(ids);
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

    /** A day range typed in India time, as the moments the search needs: from the start of `from` to the end of `to`. */
    private dayRange(from?: string, to?: string): { capturedFrom?: Date; capturedTo?: Date } {
        const out: { capturedFrom?: Date; capturedTo?: Date } = {};
        if (from) out.capturedFrom = new Date(`${from}T00:00:00+05:30`);
        if (to) out.capturedTo = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 24 * 3600_000);
        if (out.capturedFrom && out.capturedTo && out.capturedFrom >= out.capturedTo) {
            throw new BadRequestException({ code: 'BAD_DATE_RANGE', message: 'The end date comes before the start date' });
        }
        return out;
    }

    async listLeads(auth: AuthContext, query: Omit<LeadSearch, 'scope' | 'me' | 'skip' | 'take' | 'capturedFrom' | 'capturedTo'> & { page: number; pageSize: number; from?: string; to?: string }) {
        const scope = this.scopeFor(auth);
        const { page, pageSize, from, to, ...filters } = query;
        const range = this.dayRange(from, to);
        const [{ rows, total }, counts] = await Promise.all([
            this.repository.searchLeads({
                ...filters,
                ...range,
                scope,
                me: auth.publicId,
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.repository.countViews(scope, auth.publicId),
        ]);
        const ids = rows.map((r) => r.id);
        const [added, worked] = await Promise.all([this.repository.addedByStaff(ids), this.repository.lastWorkedAt(ids)]);
        const names = await this.iam.getStaffNames([...new Set(added.values())]);
        const leads = rows.map((row) =>
            toLeadView(row, { addedBy: names.get(added.get(row.id) ?? -1n) ?? null, lastWorkedAt: worked.get(row.id) ?? null }),
        );
        return { leads, total, page, pageSize, counts };
    }

    /**
     * The leads the filters match, as a CSV file (at most EXPORT_MAX rows, newest first). Follows the same scope as
     * the list, and the export is written to the audit log with the filters used, never the people in it.
     */
    async exportLeads(
        auth: AuthContext,
        query: Omit<LeadSearch, 'scope' | 'me' | 'skip' | 'take' | 'capturedFrom' | 'capturedTo'> & { from?: string; to?: string },
        meta: { ip?: string | null } = {},
    ): Promise<{ filename: string; csv: string }> {
        const scope = this.scopeFor(auth);
        const { from, to, ...filters } = query;
        const { rows, total } = await this.repository.searchLeads({
            ...filters,
            ...this.dayRange(from, to),
            scope,
            me: auth.publicId,
            skip: 0,
            take: EXPORT_MAX,
        });
        const head = ['Name', 'Phone', 'Email', 'Source', 'Contact stage', 'Pipeline stage', 'Heat', 'Score', 'Owner', 'Next step', 'Next step at', 'Added'];
        const lines = [head, ...rows.map((row) => toLeadView(row)).map((l) => [
            l.name, l.phone ?? '', l.email ?? '', l.source, l.lifecycle, l.stage ?? '', l.temperature ?? '', String(l.score),
            l.owner?.name ?? 'Unassigned', l.next.kind === 'none' ? '' : l.next.kind, l.next.at ?? '', l.createdAt,
        ])];
        const actor = await this.iam.getStaffRef(auth.publicId);
        await this.admin.audit({
            action: AuditAction.LeadsExported,
            actorId: actor?.id ?? null,
            entityType: 'lead',
            entityId: null,
            detail: { rows: rows.length, matching: total, filters: Object.keys({ ...filters, from, to }).filter((k) => (({ ...filters, from, to }) as Record<string, unknown>)[k] !== undefined) },
            ip: meta.ip ?? null,
        });
        const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
        return { filename: `leads-${day}.csv`, csv: '\uFEFF' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' };
    }

    /**
     * The pipeline board's rows. A BDA sees their own leads, everyone else the whole team's; a closer sees the team's
     * numbers but only opens leads in play. The owners list is for the owner filter and is empty for a BDA.
     */
    async boardRows(auth: AuthContext, filters: BoardFilters, perColumn: number, monthStart: Date) {
        const cardScope = this.scopeFor(auth);
        const countScope: LeadScope = cardScope.kind === 'OWNED_BY' ? cardScope : { kind: 'ALL' };
        const [rows, owners] = await Promise.all([
            this.repository.board(cardScope, countScope, filters, perColumn, monthStart),
            cardScope.kind === 'OWNED_BY' ? Promise.resolve([]) : this.repository.listLeadOwners(),
        ]);
        return { rows: rows satisfies BoardRows, owners };
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

    // ---- editing details ----

    /**
     * Changes a lead's details: name, email, phone and profile. Whoever may mark the lead may edit it.
     * The email and the phone are how a person is recognised, so neither may move to a value another lead
     * holds, and a lead keeps at least one of them. Returns the refreshed lead.
     */
    async editLead(auth: AuthContext, publicId: string, body: EditLeadBody, meta: { ip?: string | null } = {}) {
        if (!MARKING_ROLES.includes(auth.role)) {
            throw new ForbiddenException({ code: 'EDIT_NOT_ALLOWED', message: 'Your role cannot change leads' });
        }
        const lead = await this.resolveForMarking(auth, publicId);
        const patch: LeadDetailsPatch = { ...body, phone: undefined };
        if (body.phone !== undefined) {
            if (body.phone === null) patch.phone = null;
            else {
                const phone = normaliseMobile(body.phone);
                if (!phone) throw this.badField('phone', 'Enter a 10-digit Indian mobile number');
                patch.phone = phone;
            }
        }
        const current = await this.repository.findIdentityValues(lead.id);
        const emailAfter = patch.email !== undefined ? patch.email : current?.email ?? null;
        const phoneAfter = patch.phone !== undefined ? patch.phone : current?.phoneLast10 ?? null;
        if (emailAfter === null && phoneAfter === null) {
            throw this.badField(body.phone === null ? 'phone' : 'email', 'A lead needs a phone number or an email');
        }

        const result = await this.repository.updateDetails(lead.id, patch);
        if (result.kind === 'NOT_FOUND') {
            throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'This lead does not exist or you cannot open it' });
        }
        if (result.kind === 'TAKEN') {
            const other = await this.describeExisting(auth, result.leadId);
            const what = result.field === 'email' ? 'This email' : 'This phone number';
            throw new ConflictException({
                code: 'LEAD_EXISTS',
                message: `${what} belongs to another lead${other.owner ? ` (owned by ${other.owner.name})` : ''}`,
                fields: { [result.field]: `${what} belongs to another lead` },
                existing: other,
            });
        }
        if (result.changed.length > 0) {
            const actor = await this.iam.getStaffRef(auth.publicId);
            await this.timeline.append({
                leadId: lead.id,
                type: TimelineEvent.DetailsEdited,
                actorType: 'USER',
                actorId: actor?.id ?? null,
                data: { fields: result.changed },
            });
            await this.admin.audit({
                action: AuditAction.LeadEdited,
                actorId: actor?.id ?? null,
                entityType: 'lead',
                entityId: publicId,
                detail: { fields: result.changed },
                ip: meta.ip ?? null,
            });
        }
        return this.getLead(auth, publicId, { afterMarking: true });
    }

    /**
     * Sets or clears custom field values on a lead. Only the fields sent change. A field must be active and visible to
     * the person's role, the value must fit its type, and a required field cannot be cleared. Returns the refreshed lead.
     */
    async setCustomValues(auth: AuthContext, publicId: string, values: Record<string, unknown>, meta: { ip?: string | null } = {}) {
        if (!MARKING_ROLES.includes(auth.role)) {
            throw new ForbiddenException({ code: 'EDIT_NOT_ALLOWED', message: 'Your role cannot change leads' });
        }
        const lead = await this.resolveForMarking(auth, publicId);
        const defs = new Map(((await this.repository.listCustomFieldDefs()) as unknown as Array<Parameters<typeof toFieldView>[0]>).map((d) => [d.key, d]));
        const clean: Record<string, unknown> = {};
        const errors: Record<string, string> = {};
        for (const [key, raw] of Object.entries(values)) {
            const def = defs.get(key);
            const visible = def && def.isActive && (auth.role === 'ADMIN' || (Array.isArray(def.visibleRoles) && def.visibleRoles.includes(auth.role)));
            if (!def || !visible) {
                errors[key] = 'This field does not exist';
                continue;
            }
            const checked = checkFieldValue({ label: def.label, type: def.type, options: toFieldView(def).options }, raw);
            if (!checked.ok) errors[key] = checked.message;
            else if (checked.value === null && def.isRequired) errors[key] = `${def.label} is required`;
            else clean[key] = checked.value;
        }
        if (Object.keys(errors).length > 0) {
            throw new BadRequestException({ code: 'VALIDATION_FAILED', message: Object.values(errors)[0], fields: errors });
        }
        await this.repository.mergeLeadCustom(lead.id, clean);
        const actor = await this.iam.getStaffRef(auth.publicId);
        const labels = Object.keys(clean).map((k) => defs.get(k)?.label ?? k);
        await this.timeline.append({
            leadId: lead.id,
            type: TimelineEvent.DetailsEdited,
            actorType: 'USER',
            actorId: actor?.id ?? null,
            data: { fields: labels },
        });
        await this.admin.audit({
            action: AuditAction.CustomValuesEdited,
            actorId: actor?.id ?? null,
            entityType: 'lead',
            entityId: publicId,
            detail: { fields: Object.keys(clean) },
            ip: meta.ip ?? null,
        });
        return this.getLead(auth, publicId, { afterMarking: true });
    }

    /**
     * A lead someone tried to add or edit into, described for them: the name and owner, and whether they
     * may open it (a BDA may only open their own).
     */
    async describeExisting(auth: AuthContext, leadId: bigint) {
        let row = await this.repository.findLeadOwnerView(leadId);
        // A merged lead lives on in the lead it was merged into.
        for (let hops = 0; row?.mergedIntoId && hops < 5; hops++) row = await this.repository.findLeadOwnerView(row.mergedIntoId);
        if (!row) return { id: null, name: null, owner: null, canOpen: false };
        const canOpen = (await this.repository.findMarkable(row.publicId, this.scopeFor(auth))) !== null;
        return {
            id: canOpen ? row.publicId : null,
            name: canOpen ? row.fullName : null,
            owner: row.owner ? { id: row.owner.publicId, name: row.owner.name } : null,
            canOpen,
        };
    }

    // ---- merging duplicates ----

    /** A lead by public id for merging: its internal id, name, owner and whether it was merged or anonymised. */
    findMergeCandidate(publicId: string) {
        return this.repository.findMergeCandidate(publicId);
    }

    /** The lead side of a merge (see LeadsRepository.absorbLead). */
    absorbLead(keepId: bigint, dropId: bigint): Promise<{ ownerId: bigint | null }> {
        return this.repository.absorbLead(keepId, dropId);
    }

    /** Other leads with exactly the same name: the people most likely to be the same person. Managers and admins. */
    async possibleDuplicates(auth: AuthContext, publicId: string) {
        const lead = await this.resolveForMarking(auth, publicId);
        const row = await this.repository.findLeadOwnerView(lead.id);
        if (!row) return { leads: [] };
        const rows = await this.repository.findSameName(lead.id, row.fullName);
        return { leads: rows.map((row) => toLeadView(row)) };
    }

    /** Leads someone owns that should move to a new owner when they leave (see AssignmentService.moveFromPerson). */
    findHandoverLeadsOwnedBy(ownerId: bigint): Promise<AssignableLead[]> {
        return this.repository.findHandoverLeadsOwnedBy(ownerId);
    }

    countHandoverLeadsOwnedBy(ownerId: bigint): Promise<number> {
        return this.repository.countHandoverLeadsOwnedBy(ownerId);
    }

    private badField(field: string, message: string) {
        return new BadRequestException({ code: 'VALIDATION_FAILED', message, fields: { [field]: message } });
    }

    // ---- marking ----

    /**
     * Turns the do-not-contact flag on or off. Anyone who may work the lead can turn it on (a customer asked to be left
     * alone); only an admin or sales manager turns it off again. Returns the lead's id and whether anything changed.
     */
    async setDoNotContact(
        auth: AuthContext,
        publicId: string,
        value: boolean,
        reason: string | undefined,
        meta: { ip?: string | null } = {},
    ): Promise<{ leadId: bigint; changed: boolean }> {
        const lead = await this.resolveForMarking(auth, publicId);
        if (!MARKING_ROLES.includes(auth.role)) {
            throw new ForbiddenException({ code: 'DNC_NOT_ALLOWED', message: 'Your role cannot change this' });
        }
        if (!value && !['ADMIN', 'SALES_MANAGER'].includes(auth.role)) {
            throw new ForbiddenException({ code: 'DNC_CLEAR_NOT_ALLOWED', message: 'Only an admin or sales manager can allow contact again' });
        }
        const changed = await this.repository.setDoNotContact(lead.id, value);
        if (!changed) return { leadId: lead.id, changed: false };
        const actor = await this.iam.getStaffRef(auth.publicId);
        await this.timeline.append({
            leadId: lead.id,
            type: value ? TimelineEvent.DoNotContactSet : TimelineEvent.DoNotContactCleared,
            actorType: 'USER',
            actorId: actor?.id ?? null,
            data: reason ? { reason } : {},
        });
        await this.admin.audit({
            action: value ? AuditAction.DoNotContactSet : AuditAction.DoNotContactCleared,
            actorId: actor?.id ?? null,
            entityType: 'lead',
            entityId: publicId,
            detail: reason ? { reason } : {},
            ip: meta.ip ?? null,
        });
        return { leadId: lead.id, changed: true };
    }

    /**
     * Which of these phones and emails belong to a lead marked do-not-contact. Phones are matched on their last ten
     * digits, emails ignoring case; numbers that are not valid mobiles cannot match and are reported as `invalid`.
     */
    async checkSuppression(phones: string[], emails: string[]) {
        const normalised = new Map<string, string>();
        const invalid: string[] = [];
        for (const raw of phones) {
            const n = normaliseMobile(raw);
            if (n) normalised.set(raw, n.phoneLast10);
            else invalid.push(raw);
        }
        const mails = new Map(emails.map((e) => [e, e.toLowerCase()]));
        const hit = await this.repository.findSuppressed([...new Set(normalised.values())], [...new Set(mails.values())]);
        const p = new Set(hit.phones);
        const e = new Set(hit.emails);
        return {
            suppressedPhones: phones.filter((raw) => p.has(normalised.get(raw) ?? '')),
            suppressedEmails: emails.filter((raw) => e.has(mails.get(raw) ?? '')),
            invalidPhones: invalid,
        };
    }

    /** Erases the lead's own personal details (see the repository). The other modules erase theirs first. */
    eraseLead(leadId: bigint): Promise<void> {
        return this.repository.erase(leadId, new Date());
    }

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
        this.checkStageForRole(auth, stage);
        await this.changeContactStage(auth, publicId, stage, auth);
        return this.getLead(auth, publicId, { afterMarking: true });
    }

    /**
     * The same change for many leads at once, with the same rules for each. A lead the rules refuse is left alone
     * and counted with the reason; the rest change. Rules that depend only on the role refuse the whole request.
     */
    async bulkSetContactStage(auth: AuthContext, publicIds: string[], stage: string): Promise<BulkResult> {
        this.checkStageForRole(auth, stage);
        const actor = { actorId: (await this.iam.getStaffRef(auth.publicId))?.id ?? null };
        return runBulk([...new Set(publicIds)], (publicId) => this.changeContactStage(auth, publicId, stage, actor));
    }

    /** The rules that depend only on who is asking and where the lead is going. */
    private checkStageForRole(auth: AuthContext, stage: string): void {
        if (!(stage === 'LEARNER_ONBOARDED' ? ONBOARDING_ROLES : MARKING_ROLES).includes(auth.role)) {
            throw new ForbiddenException({ code: 'CONTACT_STAGE_NOT_ALLOWED', message: 'Your role cannot change the contact stage' });
        }
        if (stage === 'ENROLLED') {
            throw new ConflictException({
                code: 'ENROLL_VIA_CLOSED_WON',
                message: 'A lead becomes Enrolled when its opportunity is moved to Closed Won, after payment or financing is complete',
            });
        }
    }

    /** Changes one lead's contact stage. Returns whether it changed (false when it was already there). */
    private async changeContactStage(auth: AuthContext, publicId: string, stage: string, by: { actorId: bigint | null } | AuthContext): Promise<boolean> {
        const lead = await this.resolveForMarking(auth, publicId);
        const from = lead.lifecycleStage as string;
        if (from === stage) return false;
        if (stage === 'LEARNER_ONBOARDED') {
            if (from !== 'ENROLLED') {
                throw new ConflictException({ code: 'ONBOARD_AFTER_ENROLLED', message: 'Only an Enrolled lead can be marked Learner Onboarded' });
            }
        } else if ((from === 'ENROLLED' || from === 'LEARNER_ONBOARDED') && !['ADMIN', 'SALES_MANAGER'].includes(auth.role)) {
            throw new ForbiddenException({ code: 'CONTACT_STAGE_NOT_ALLOWED', message: 'Only an admin or sales manager can move an enrolled lead back' });
        }
        await this.applyLifecycle(lead.id, from, stage, by);
        return true;
    }

    /** Used when an opportunity is won: the contact stage becomes Enrolled. */
    async markEnrolled(leadId: bigint, actorId: bigint | null): Promise<void> {
        const lead = await this.repository.findLifecycle(leadId);
        if (!lead || lead.lifecycleStage === 'ENROLLED' || lead.lifecycleStage === 'LEARNER_ONBOARDED') return;
        await this.applyLifecycle(leadId, lead.lifecycleStage as string, 'ENROLLED', { actorId });
    }

    // ---- what the calls and tasks step needs ----

    /** A call, message or note was logged: notes the touch and the attempt count. Returns the attempts since the last connected call. */
    recordTouch(leadId: bigint, at: Date, change: { connected: boolean | null; countsAsAttempt: boolean }): Promise<number> {
        return this.repository.recordTouch(leadId, at, change);
    }

    /** The due time of the lead's earliest open follow-up (null when there is none). */
    setNextFollowup(leadId: bigint, at: Date | null): Promise<void> {
        return this.repository.setNextFollowup(leadId, at);
    }

    /**
     * Sets the contact stage as the result of a logged call. It never takes a lead backwards on its own:
     * Engaged and Prospect only move a lead forward (a connected call can bring back one who was Not Interested or
     * Exhausted), Exhausted only follows from Marketing or Engaged, Not Interested can follow any open lead, and
     * enrolled leads are left alone. Returns whether the stage changed.
     */
    async applyOutcomeLifecycle(leadId: bigint, to: string, actorId: bigint | null): Promise<boolean> {
        const lead = await this.repository.findLifecycle(leadId);
        if (!lead) return false;
        const from = lead.lifecycleStage as string;
        if (from === to || from === 'ENROLLED' || from === 'LEARNER_ONBOARDED') return false;
        if (to === 'ENGAGED_LEAD' || to === 'PROSPECT') {
            if ((OUTCOME_RANK[from] ?? -1) >= OUTCOME_RANK[to]!) return false;
        } else if (to === 'EXHAUSTED_NOT_CONNECTED') {
            if (from !== 'MARKETING_LEAD' && from !== 'ENGAGED_LEAD') return false;
        }
        try {
            await this.applyLifecycle(leadId, from, to, { actorId });
        } catch (error) {
            if (error instanceof ConflictException) return false;
            throw error;
        }
        return true;
    }

    /** Sets the temperature by hand. */
    async setTemperature(leadId: bigint, temperature: 'HOT' | 'WARM' | 'COLD', actorId: bigint | null): Promise<void> {
        const before = await this.repository.updateTemperature(leadId, temperature);
        if (before === undefined) return;
        await this.timeline.append({
            leadId,
            type: TimelineEvent.TemperatureChanged,
            actorType: actorId === null ? 'SYSTEM' : 'USER',
            actorId,
            data: { from: before, to: temperature },
        });
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
            // An old link to a lead that was merged away points on to the lead it became, if this person may open it.
            let merged = await this.repository.findMergeCandidate(publicId);
            for (let hops = 0; merged?.mergedIntoId && hops < 5; hops++) {
                const next = await this.repository.findLeadOwnerView(merged.mergedIntoId);
                merged = next ? await this.repository.findMergeCandidate(next.publicId) : null;
            }
            if (merged && merged.publicId !== publicId && (await this.repository.findMarkable(merged.publicId, scope))) {
                throw new NotFoundException({ code: 'LEAD_MERGED', message: 'This lead was merged into another lead', existing: { id: merged.publicId } });
            }
            throw new NotFoundException({ code: 'LEAD_NOT_FOUND', message: 'This lead does not exist or you cannot open it' });
        }
        const [fieldRows, names] = await Promise.all([
            this.repository.listCustomFieldDefs(),
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
        const lastWorkedAt = (await this.repository.lastWorkedAt([row.id])).get(row.id) ?? null;
        const vslRows = await this.repository.vslSummary(row.id);
        const hasVsl = row.vslDepth !== 'NONE' || vslRows.forms.length > 0 || vslRows.bookings.length > 0;
        const custom = (row.custom ?? {}) as Record<string, unknown>;
        const visibleFields = (fieldRows as unknown as Parameters<typeof toFieldView>[0][]).filter(
            (f) => f.isActive && (auth.role === 'ADMIN' || (Array.isArray(f.visibleRoles) && f.visibleRoles.includes(auth.role))),
        );
        const lists = new Map(row.listMembers.map((m) => [m.list.publicId, m.list.name]));
        return {
            lead: {
                ...toLeadView(row, { lastWorkedAt }),
                company: row.currentCompany,
                ctc: row.currentCtc,
                graduationYear: row.graduationYear,
                domain: row.domain,
                userType: row.userType,
                doNotContact: row.doNotContact,
                lists: row.listMembers.map((m) => ({ id: m.list.publicId, name: m.list.name })),
                customFields: visibleFields
                    .filter((f) => custom[f.key] !== undefined && custom[f.key] !== null && custom[f.key] !== '')
                    .map((f) => ({ label: f.label, value: showCustom(custom[f.key]) })),
                /** Every field this role may see, filled or not, with the type so the page can edit it. */
                customForm: visibleFields.map((f) => ({ ...toFieldView(f), value: custom[f.key] ?? null })),
            },
            vsl: hasVsl
                ? {
                      depth: row.vslDepth,
                      score: row.formScore,
                      temperature: row.temperature,
                      forms: vslRows.forms.map((f) => ({
                          formSlug: f.formSlug,
                          score: f.score,
                          temperature: f.temperature,
                          submittedAt: f.submittedAt.toISOString(),
                          answers: Array.isArray(f.answers) ? f.answers : [],
                      })),
                      bookings: vslRows.bookings.map((b) => ({
                          slotStartAt: b.slotStartAt.toISOString(),
                          slotLabel: b.slotLabel,
                          status: b.status,
                          completedAt: b.completedAt?.toISOString() ?? null,
                      })),
                  }
                : null,
            opportunity: row.detailOpportunity
                ? {
                      stage: row.detailOpportunity.stage,
                      status: row.detailOpportunity.status,
                      openedAt: row.detailOpportunity.openedAt.toISOString(),
                      stageChangedAt: row.detailOpportunity.stageChangedAt.toISOString(),
                      closedAt: row.detailOpportunity.closedAt?.toISOString() ?? null,
                      testOn: dayOf(row.detailOpportunity.testOn),
                      psychometricOn: dayOf(row.detailOpportunity.psychometricOn),
                      wonOn: dayOf(row.detailOpportunity.wonOn),
                      lostReason: row.detailOpportunity.lostReason?.name ?? null,
                      lostNote: row.detailOpportunity.lostNote,
                      enrolment: row.detailOpportunity.enrolment
                          ? {
                                program: row.detailOpportunity.enrolment.program,
                                feeAmount: row.detailOpportunity.enrolment.feeAmount,
                                amountCollected: row.detailOpportunity.enrolment.amountCollected,
                                paymentMode: row.detailOpportunity.enrolment.paymentMode,
                                note: row.detailOpportunity.enrolment.note,
                                updatedAt: row.detailOpportunity.enrolment.updatedAt.toISOString(),
                            }
                          : null,
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

const showCustom = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

/** The most leads one export holds. */
export const EXPORT_MAX = 5000;

/** One CSV cell. Quotes what needs it, and defuses a leading = + - @ so a spreadsheet never runs it as a formula. */
export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * `addedBy` is the name of the person who added the lead, when a person did. `lastWorkedAt` is the newest stage move
 * or task change a person made; the last activity shown is the later of that and the last call or note.
 */
export function toLeadView(row: LeadListRow, extra: { addedBy?: string | null; lastWorkedAt?: Date | null } = {}) {
    const lastActivity = [row.lastActivityAt, extra.lastWorkedAt ?? null].reduce<Date | null>(
        (latest, at) => (at && (!latest || at > latest) ? at : latest),
        null,
    );
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
        addedBy: extra.addedBy ?? null,
        lastActivityAt: lastActivity?.toISOString() ?? null,
    };
}

const dueText = (value: unknown): string => {
    const date = typeof value === 'string' ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Due soon';
    return `Due ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(date)}`;
};

const FIELD_LABEL: Record<EditableField, string> = {
    fullName: 'Name',
    email: 'Email',
    phone: 'Phone',
    currentCompany: 'Company',
    currentCtc: 'CTC',
    graduationYear: 'Graduation year',
    domain: 'Domain',
};

const OUTCOME_RANK: Record<string, number> = { MARKETING_LEAD: 0, ENGAGED_LEAD: 1, PROSPECT: 2 };

/** A date column as YYYY-MM-DD, or null. */
const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

/** "24 Nov 2026" from a YYYY-MM-DD in an event's data, or null. */
const dayLabel = (value: unknown): string | null => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

const stageName = (value: unknown) =>
    typeof value === 'string'
        ? value.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        : '';

const vslStepTitle = (step: unknown): string =>
    step === 'FORM' ? 'Filled the VSL form' : step === 'BOOKING' ? 'Booked on the VSL' : 'Gave details on the VSL';

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
            title = data.importJob
                ? 'Lead created from a CSV import'
                : data.via === 'MANUAL'
                  ? 'Added by hand'
                  : data.via === 'WORKR'
                  ? 'Signed up on WorkR'
                  : data.via === 'VSL'
                    ? vslStepTitle(data.step)
                    : 'Lead created';
            sub =
                data.via === 'VSL'
                    ? 'Found through the VSL funnel'
                    : data.via === 'WORKR'
                    ? list
                        ? `Through the WorkR signup form, added to the list “${list}”`
                        : 'Through the WorkR signup form'
                    : list
                      ? `Added to the list “${list}” by ${who}`
                      : `By ${who}`;
            break;
        }
        case 'TOUCHPOINT_ADDED':
            title = data.importJob
                ? 'Appeared again in a CSV import'
                : data.via === 'WORKR'
                  ? 'Signed up on WorkR again'
                  : data.via === 'VSL'
                    ? vslStepTitle(data.step)
                    : 'Came in again';
            sub = `Recorded by ${who}; nothing was overwritten`;
            break;
        case 'ASSIGNED': {
            const to = typeof data.to === 'string' ? owners.get(data.to) : undefined;
            title = to ? `Assigned to ${to}` : 'Assigned';
            sub =
                data.method === 'IMPORT'
                    ? `By ${who} during an import`
                    : data.method === 'SYSTEM'
                      ? 'Automatically, as the owner of new WorkR signups'
                      : data.method === 'BULK'
                        ? `By ${who} in a hand-over`
                        : `By ${who}`;
            break;
        }
        case 'FORM_SUBMITTED': {
            const score = typeof data.score === 'number' ? data.score : null;
            const temperature = typeof data.temperature === 'string' ? data.temperature.toLowerCase() : null;
            title = 'Filled the qualification form';
            sub = score !== null ? `Scored ${score} out of 100${temperature ? `, ${temperature}` : ''}` : 'No score was given';
            break;
        }
        case 'SLOT_BOOKED':
            title = 'Booked a counselling call';
            sub = typeof data.slot === 'string' ? `For ${data.slot}` : 'Through the VSL';
            break;
        case 'BOOKING_COMPLETED':
            title = 'Counselling call marked as done';
            sub = typeof data.slot === 'string' ? `The call booked for ${data.slot}` : 'Marked by the VSL team';
            break;
        case 'BOOKING_CANCELLED':
            title = 'Counselling call cancelled';
            sub = typeof data.slot === 'string' ? `The call booked for ${data.slot}` : 'Cancelled on the VSL';
            break;
        case 'BOOKING_RESCHEDULED':
            title = 'Counselling call rescheduled';
            sub = typeof data.slot === 'string' ? `Now ${data.slot}` : 'Moved on the VSL';
            break;
        case 'BOOKING_REOPENED':
            title = 'Counselling call is no longer marked done';
            sub = typeof data.slot === 'string' ? `The call booked for ${data.slot}` : 'Changed by the VSL team';
            break;
        case 'DETAILS_EDITED': {
            const fields = Array.isArray(data.fields) ? (data.fields as string[]) : [];
            const names = fields.map((f) => FIELD_LABEL[f as EditableField] ?? f);
            title = names.length === 1 ? `${names[0]} updated` : 'Details updated';
            sub = names.length > 1 ? `${names.join(', ')} changed by ${who}` : `By ${who}`;
            break;
        }
        case 'DO_NOT_CONTACT_SET':
            title = 'Marked do not contact';
            sub = `${typeof data.reason === 'string' && data.reason ? `${data.reason}. ` : ''}By ${who}`;
            break;
        case 'DO_NOT_CONTACT_CLEARED':
            title = 'Contact allowed again';
            sub = `By ${who}`;
            break;
        case 'LEAD_ANONYMISED':
            title = 'Personal details erased';
            sub = `The lead was anonymised. By ${who}`;
            break;
        case 'LEADS_MERGED':
            title = 'A duplicate was merged into this lead';
            sub = `Its history, calls and follow-ups are now here. By ${who}`;
            break;
        case 'OPPORTUNITY_OPENED':
            title = `Opportunity opened at ${stageName(data.stage) || 'the first stage'}`;
            sub = `By ${who}`;
            break;
        case 'CONTACT_STAGE_CHANGED':
            title = `Contact stage changed to ${stageName(data.to)}`;
            sub = `From ${stageName(data.from)} by ${who}`;
            break;
        case 'OPPORTUNITY_STAGE_CHANGED': {
            const on = dayLabel(data.on);
            if (data.rescheduled === true) {
                title = `${stageName(data.to)} moved to ${on ?? 'a new date'}`;
                sub = `Rescheduled by ${who}`;
            } else {
                title = on ? `Moved to ${stageName(data.to)} for ${on}` : `Moved to ${stageName(data.to)}`;
                sub = `From ${stageName(data.from)} by ${who}`;
            }
            break;
        }
        case 'OPPORTUNITY_WON': {
            const on = dayLabel(data.on);
            title = on ? `Opportunity won on ${on}` : 'Opportunity won';
            sub = `Closed at ${stageName(data.stage)} by ${who}`;
            break;
        }
        case 'OPPORTUNITY_LOST':
            title = typeof data.reason === 'string' ? `Marked lost: ${data.reason}` : 'Marked lost';
            sub = `At ${stageName(data.stage)} by ${who}`;
            break;
        case 'ACTIVITY_LOGGED': {
            const kind = data.kind;
            const outcome = typeof data.outcome === 'string' ? data.outcome : null;
            title =
                kind === 'CALL'
                    ? `Call: ${outcome ?? 'logged'}`
                    : kind === 'WHATSAPP'
                      ? 'WhatsApp message logged'
                      : kind === 'EMAIL'
                        ? 'Email logged'
                        : 'Note added';
            sub =
                kind === 'CALL' && typeof data.attempt === 'number'
                    ? `Attempt ${data.attempt} without a connection, by ${who}`
                    : `By ${who}`;
            break;
        }
        case 'TASK_CREATED':
            title = 'Follow-up set';
            sub = `${dueText(data.dueAt)} · by ${who}`;
            break;
        case 'TASK_UPDATED': {
            const parts = [
                typeof data.dueAt === 'string' ? `moved to ${dueText(data.dueAt).replace(/^Due /, '')}` : null,
                data.renamed ? 'reworded' : null,
                data.reassigned ? 'given to someone else' : null,
            ].filter(Boolean);
            title = 'Follow-up changed';
            sub = `${parts.join(', ') || 'Updated'} · by ${who}`;
            break;
        }
        case 'TASK_DONE':
            title = 'Follow-up done';
            sub = `By ${who}`;
            break;
        case 'TASK_CANCELLED':
            title = 'Follow-up cancelled';
            sub = `By ${who}`;
            break;
        case 'TEMPERATURE_CHANGED':
            title = `Temperature set to ${typeof data.to === 'string' ? data.to.toLowerCase() : 'a new value'}`;
            sub = `By ${who}`;
            break;
        default:
            title = stageName(event.type);
            sub = `By ${who}`;
    }
    // `ref` points at the logged activity, so the page can show its notes under the event.
    return { id: String(event.id), type: event.type, title, sub, at: event.occurredAt.toISOString(), ref: typeof data.activity === 'string' ? data.activity : null };
}
