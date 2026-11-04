import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AssignmentService } from '@modules/assignment';
import { IamService, type SourceSystemName, type StaffRef } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { LOCK_MS, MAX_ATTEMPTS, RETRY_DELAYS_MS } from './intake.constants.js';
import { IntakeQueue } from './intake.queue.js';
import { IntakeRepository } from './intake.repository.js';
import { EVENT_TYPES, type EventEnvelope, PAYLOAD_SCHEMAS } from './intake.schemas.js';
import {
    type EventView,
    type InboxListRow,
    type InboxRow,
    type IntakeOutcome,
    type IntakeSummary,
    PermanentIntakeError,
    type SourceHealth,
} from './intake.types.js';
import { VslIntakeService } from './vsl-intake.service.js';
import {
    isWorkingProfessional,
    istDayKey,
    istDayLabel,
    normalisePhone,
    type WorkrSignup,
} from './workr-signup.js';

const SOURCE_NAMES: Record<SourceSystemName, { name: string; events: string }> = {
    WORKR: { name: 'WorkR · User-Service', events: 'workr.signup' },
    VSL_FORM: { name: 'VSL · candidate-form-details', events: 'details_submitted, form_submitted' },
    VSL_BOOKING: { name: 'VSL · slot-booking', events: 'slot_booked, booking_completed' },
};

/** Prefix of the daily lists' origin ref; the assignment module finds them by it. */
const DAY_LIST_PREFIX = 'workr-day:';
const FIRST_STAGE = 'CALL_1_PENDING';

@Injectable()
export class IntakeService {
    private readonly logger = new Logger(IntakeService.name);

    constructor(
        private readonly repository: IntakeRepository,
        private readonly queue: IntakeQueue,
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly assignment: AssignmentService,
        private readonly timeline: TimelineService,
        private readonly iam: IamService,
        private readonly vsl: VslIntakeService,
    ) {}

    // ---- receiving ----

    /**
     * Stores an event and queues it. The sender gets its answer as soon as the event is stored: the
     * work of turning it into a lead happens in the worker, so a slow or failing step never makes
     * the sender wait or resend.
     */
    async receive(
        source: SourceSystemName,
        event: EventEnvelope,
    ): Promise<{ id: string; duplicate: boolean }> {
        const allowed = (EVENT_TYPES as Record<string, readonly string[]>)[source] ?? [];
        if (!allowed.includes(event.type)) {
            throw new BadRequestException({
                code: 'EVENT_TYPE_NOT_ALLOWED',
                message: `This key cannot send ${event.type} events`,
                fields: { type: 'Not an event this key may send' },
            });
        }
        const parsed = PAYLOAD_SCHEMAS[event.type]!.safeParse(event.payload);
        if (!parsed.success) {
            const fields = Object.fromEntries(
                parsed.error.issues.map((issue) => [issue.path.join('.') || 'payload', issue.message]),
            );
            throw new BadRequestException({
                code: 'PAYLOAD_INVALID',
                message: 'The event payload is not valid',
                fields,
            });
        }
        const stored = await this.repository.insertEvent({
            eventId: event.eventId,
            source,
            type: event.type,
            occurredAt: event.occurredAt,
            payload: parsed.data as object,
            now: new Date(),
        });
        if (!stored.duplicate) await this.queue.enqueue(stored.id);
        return { id: String(stored.id), duplicate: stored.duplicate };
    }

    // ---- the worker ----

    /** Turns one stored event into its effect. Never throws: its outcome is written on the event. */
    async process(inboxId: bigint): Promise<void> {
        const now = new Date();
        const event = await this.repository.claim(inboxId, now, LOCK_MS);
        if (!event) return; // already done, or another worker has it
        try {
            const result = await this.apply(event);
            await this.repository.markProcessed(event.id, { ...result, now: new Date() });
        } catch (error) {
            await this.fail(event, error);
        }
    }

    private async fail(event: InboxRow, error: unknown): Promise<void> {
        if (error instanceof PermanentIntakeError) {
            this.logger.warn(`Inbox event ${event.id} cannot be processed: ${error.code}`);
            await this.repository.markDead(event.id, `${error.code}: ${error.message}`);
            return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Inbox event ${event.id} failed (try ${event.attempts}): ${reason}`);
        if (event.attempts >= MAX_ATTEMPTS) {
            await this.repository.markDead(event.id, `Gave up after ${event.attempts} tries: ${reason}`);
            return;
        }
        const delay = RETRY_DELAYS_MS[Math.min(event.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
        await this.repository.markFailed(event.id, {
            error: reason,
            nextAttemptAt: new Date(Date.now() + delay),
        });
        await this.queue.enqueue(event.id, delay);
    }

    private async apply(event: InboxRow): Promise<{ leadId: bigint | null; outcome: IntakeOutcome }> {
        if (event.type === 'workr.signup') return this.applyWorkrSignup(event);
        if (event.type.startsWith('vsl.')) return this.vsl.apply(event);
        throw new PermanentIntakeError('UNKNOWN_EVENT_TYPE', `No handler for ${event.type}`);
    }

    private async applyWorkrSignup(event: InboxRow): Promise<{ leadId: bigint | null; outcome: IntakeOutcome }> {
        const parsed = PAYLOAD_SCHEMAS['workr.signup']!.safeParse(event.payload);
        if (!parsed.success) {
            const fields = parsed.error.issues.map((i) => i.path.join('.') || 'payload').join(', ');
            throw new PermanentIntakeError('PAYLOAD_INVALID', `Fields not valid: ${fields}`);
        }
        const signup = parsed.data as WorkrSignup;

        // Defence in depth: WorkR already sends working professionals only.
        if (!isWorkingProfessional(signup.details)) return { leadId: null, outcome: 'IGNORED' };

        const phone = normalisePhone(signup.phoneNo);
        const owner = await this.intakeOwner();
        const source = await this.workrSource();
        const list = await this.dayList(event.occurredAt, owner.id);

        const ref = `workr:signup:${signup.userId}`;
        const outcome = await this.leads.importLead({
            fields: {
                fullName: signup.fullName,
                email: signup.email,
                phoneE164: phone?.phoneE164 ?? null,
                phoneLast10: phone?.phoneLast10 ?? null,
                currentCompany: signup.currentCompany || null,
                currentCtc: signup.currentCtc || null,
                graduationYear: /^\d{4}$/.test(signup.graduationYear ?? '') ? signup.graduationYear! : null,
                domain: signup.domain || null,
                userType: 'WORKING_PROFESSIONAL',
                custom: {},
            },
            sourceId: source.id,
            ownerId: owner.id,
            listId: list.id,
            ref,
            // A person who is already a lead keeps everything they have; only gaps are filled.
            handling: 'FILL_EMPTY',
            initialScore: 0,
            kind: 'SIGNUP',
            touchpointPayload: { workrUserId: signup.userId, inboxEvent: event.eventId },
        });

        if (outcome.kind === 'CONFLICT') {
            throw new PermanentIntakeError(
                'IDENTITY_CONFLICT',
                'The email and the phone number belong to two different leads. Merge them, then retry this event',
            );
        }

        if (outcome.kind === 'MATCHED') {
            // Already a lead: their owner, list and stage stay as they are.
            if (!outcome.resumed) {
                await this.timeline.append({
                    leadId: outcome.match.leadId,
                    type: TimelineEvent.TouchpointAdded,
                    actorType: 'SYSTEM',
                    actorId: null,
                    data: { via: 'WORKR', sourceId: source.id },
                });
            }
            return { leadId: outcome.match.leadId, outcome: 'MATCHED' };
        }

        // A new lead. Everything below is safe to repeat, so a retry finishes what a failed try began.
        const leadId = outcome.leadId;
        const opportunity = await this.pipeline.openOpportunity({ leadId, ownerId: owner.id, actorId: null });
        await this.assignment.recordSystemAssignment(
            { leadId, toUserId: owner.id, sourceId: source.id, batchId: list.batchId },
            { mayExist: outcome.resumed },
        );
        const events = [
            {
                leadId,
                type: TimelineEvent.LeadCreated,
                actorType: 'SOURCE' as const,
                actorId: null,
                data: { via: 'WORKR', sourceId: source.id, list: list.publicId },
            },
            {
                leadId,
                type: TimelineEvent.Assigned,
                actorType: 'SYSTEM' as const,
                actorId: null,
                data: { to: owner.publicId, method: 'SYSTEM' },
            },
            {
                leadId,
                type: TimelineEvent.OpportunityOpened,
                actorType: 'SYSTEM' as const,
                actorId: null,
                data: { stage: FIRST_STAGE, opportunity: opportunity.publicId },
            },
        ];
        if (outcome.resumed) for (const e of events) await this.timeline.appendOnce(e);
        else await this.timeline.appendMany(events);
        return { leadId, outcome: 'CREATED' };
    }

    /** Who new WorkR leads belong to until they are handed over: INTAKE_OWNER_EMAIL, or else the longest-serving admin. */
    private async intakeOwner() {
        const email = process.env.INTAKE_OWNER_EMAIL?.trim().toLowerCase();
        let chosen: StaffRef | null | undefined;
        if (email) {
            const byEmail = await this.iam.getActiveStaffByEmail(email);
            chosen = byEmail?.role === 'ADMIN' ? byEmail : null;
        } else {
            const staff = await this.iam.listActiveStaff(['ADMIN']);
            chosen = [...staff].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
        }
        if (!chosen) {
            // A setup problem, not a bad event: it is tried again, and the Intake monitor shows why.
            throw new Error(
                email ? `INTAKE_OWNER_EMAIL (${email}) is not an active admin` : 'There is no active admin to own new WorkR leads',
            );
        }
        return chosen;
    }

    private async workrSource() {
        const sources = await this.leads.listSources();
        const found = sources.find((s) => s.name === 'WorkR') ?? sources.find((s) => s.group === 'WORKR');
        if (!found) throw new Error('There is no active lead source for WorkR');
        return found;
    }

    /** The list of the day a person signed up (Indian time), made when its first lead arrives. */
    private async dayList(at: Date, ownerId: bigint) {
        const day = istDayKey(at);
        const originRef = `${DAY_LIST_PREFIX}${day}`;
        const make = (name: string) =>
            this.leads.createList({
                name,
                description: 'Working professionals who signed up on WorkR this day, waiting to be handed over',
                originRef,
                createdById: ownerId,
            });
        const base = `WorkR signups · ${istDayLabel(at)}`;
        let list;
        try {
            list = await make(base);
        } catch (error) {
            // Somebody already made a list with this name by hand: use a name of our own.
            if (!(error instanceof ConflictException)) throw error;
            list = await make(`${base} (auto)`);
        }
        return { id: list.id, publicId: list.publicId, batchId: originRef };
    }

    // ---- the sweeper ----

    /** Queues events nobody is handling (the queue was down when they came, or a worker died). */
    async sweep(): Promise<number> {
        const now = new Date();
        const due = await this.repository.findDue(now, 200);
        for (const id of due) await this.queue.enqueue(id);
        await this.repository.purgePayloads(now);
        return due.length;
    }

    // ---- the Intake monitor ----

    async listEvents(status: 'all' | 'failed' | 'dead' | 'processed', limit: number): Promise<EventView[]> {
        const filter =
            status === 'failed' ? (['FAILED'] as const)
            : status === 'dead' ? (['DEAD'] as const)
            : status === 'processed' ? (['PROCESSED'] as const)
            : null;
        const rows = await this.repository.listRecent(filter ? [...filter] : null, limit);
        const names = await this.leads.leadNames([...new Set(rows.flatMap((r) => (r.leadId ? [r.leadId] : [])))]);
        return rows.map((row) => this.toView(row, names));
    }

    private toView(row: InboxListRow, names: Map<bigint, { name: string; publicId: string }>): EventView {
        const lead = row.leadId ? names.get(row.leadId) : undefined;
        const status =
            row.status === 'PROCESSED' ? 'Processed'
            : row.status === 'FAILED' ? 'Failed'
            : row.status === 'DEAD' ? 'Dead'
            : 'Received';
        let detail: string;
        if (row.status === 'PROCESSED') {
            detail =
                row.outcome === 'IGNORED' ? 'Skipped: not a working professional'
                : row.outcome === 'MATCHED' ? `${lead?.name ?? 'A lead'} (already a lead)`
                : row.outcome === 'UPDATED' ? `${lead?.name ?? 'A lead'} (updated)`
                : (lead?.name ?? 'New lead');
        } else if (row.status === 'FAILED' || row.status === 'DEAD') {
            detail = row.lastError ?? 'Failed';
        } else {
            detail = row.status === 'PROCESSING' ? 'Being processed' : 'Waiting in queue';
        }
        return {
            id: String(row.id),
            at: row.receivedAt.toISOString(),
            source: SOURCE_NAMES[row.source].name,
            event: row.type,
            status,
            tries: row.attempts,
            detail,
            leadId: lead?.publicId ?? null,
        };
    }

    async retry(id: bigint): Promise<{ ok: true }> {
        const reset = await this.repository.reset(id, new Date());
        if (!reset) {
            throw new NotFoundException({
                code: 'EVENT_NOT_RETRYABLE',
                message: 'Only a failed event whose details are still stored can be retried',
            });
        }
        await this.queue.enqueue(id);
        return { ok: true };
    }

    async summary(): Promise<IntakeSummary> {
        const now = new Date();
        // The Indian day, so "today" is the team's today.
        const dayStart = new Date(`${istDayKey(now)}T00:00:00+05:30`);
        const [today, open, created] = await Promise.all([
            this.repository.countByStatusSince(dayStart),
            this.repository.countOpenProblems(),
            this.repository.countCreatedSince(dayStart),
        ]);
        const sources: SourceHealth[] = [];
        for (const id of Object.keys(SOURCE_NAMES) as SourceSystemName[]) {
            const last = await this.repository.lastReceivedAt(id);
            const since = new Date(now.getTime() - 12 * 3_600_000);
            const times = await this.repository.receivedTimesSince(id, since);
            const spark = Array.from({ length: 12 }, () => 0);
            for (const t of times) {
                const bucket = Math.min(11, Math.floor((t.getTime() - since.getTime()) / 3_600_000));
                spark[bucket] = (spark[bucket] ?? 0) + 1;
            }
            const startOfDayCount = times.filter((t) => t >= dayStart).length;
            sources.push({
                id,
                name: SOURCE_NAMES[id].name,
                events: SOURCE_NAMES[id].events,
                status: !last ? 'Never' : now.getTime() - last.getTime() > 24 * 3_600_000 ? 'Quiet' : 'Healthy',
                lastEvent: last?.toISOString() ?? null,
                today: startOfDayCount,
                spark,
            });
        }
        const total = Object.values(today).reduce((a, b) => a + b, 0);
        return {
            received: total,
            processed: today.PROCESSED ?? 0,
            failed: open.failed,
            dead: open.dead,
            created,
            sources,
        };
    }
}
