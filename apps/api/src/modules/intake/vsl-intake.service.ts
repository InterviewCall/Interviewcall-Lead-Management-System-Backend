import { Injectable, Logger } from '@nestjs/common';
import { LeadsService, type ImportedLeadFields } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';
import { TimelineEvent, TimelineService } from '@modules/timeline';
import { PAYLOAD_SCHEMAS } from './intake.schemas.js';
import { type InboxRow, type IntakeOutcome, PermanentIntakeError } from './intake.types.js';
import {
    matchSource,
    profileFromAnswers,
    type SourceContext,
    type VslBooked,
    type VslCompleted,
    type VslDetails,
    type VslForm,
} from './vsl-events.js';
import { normalisePhone } from './workr-signup.js';

type Applied = { leadId: bigint | null; outcome: IntakeOutcome };
type Step = 'DETAILS' | 'FORM' | 'BOOKING';
type Person = { fullName: string; email: string; phone?: string | null };

/** A person who is already enrolled is not put back in the pipeline by filling a form again. */
const ENROLLED = new Set(['ENROLLED', 'LEARNER_ONBOARDED']);

/**
 * The three steps of the VSL funnel, as the CRM sees them. A person can stop after any step, so
 * each step is a lead by itself:
 *   details  -> a lead, with an open opportunity at Call 1 Pending
 *   form     -> the same lead, now with answers, a score and a temperature
 *   booking  -> the same lead, now with a booked call
 * New VSL leads have no owner: they wait in the Unassigned view, ranked by how far they got, for
 * the sales manager to give out. Every event carries the person's contact details, so the order
 * events arrive in does not matter: whichever comes first makes the lead and the rest find it.
 */
@Injectable()
export class VslIntakeService {
    private readonly logger = new Logger(VslIntakeService.name);

    constructor(
        private readonly leads: LeadsService,
        private readonly pipeline: PipelineService,
        private readonly timeline: TimelineService,
    ) {}

    async apply(event: InboxRow): Promise<Applied> {
        switch (event.type) {
            case 'vsl.details_submitted':
                return this.details(event, this.parse<VslDetails>(event));
            case 'vsl.form_submitted':
                return this.form(event, this.parse<VslForm>(event));
            case 'vsl.slot_booked':
                return this.booked(event, this.parse<VslBooked>(event));
            case 'vsl.booking_completed':
                return this.completed(this.parse<VslCompleted>(event));
            default:
                throw new PermanentIntakeError('UNKNOWN_EVENT_TYPE', `No handler for ${event.type}`);
        }
    }

    private parse<T>(event: InboxRow): T {
        const parsed = PAYLOAD_SCHEMAS[event.type]!.safeParse(event.payload);
        if (!parsed.success) {
            const fields = parsed.error.issues.map((i) => i.path.join('.') || 'payload').join(', ');
            throw new PermanentIntakeError('PAYLOAD_INVALID', `Fields not valid: ${fields}`);
        }
        return parsed.data as T;
    }

    // ---- the steps ----

    private details(event: InboxRow, p: VslDetails): Promise<Applied> {
        return this.capture(event, 'DETAILS', p, `vsl:details:${p.submissionId}`, {
            context: { system: 'VSL_FORM', formSlug: p.formSlug, utmSource: p.utmSource, utmMedium: p.utmMedium, utmCampaign: p.utmCampaign },
            payload: { formSlug: p.formSlug, submission: p.submissionId, source: p.source, landingPage: p.landingPage, utmSource: p.utmSource, utmMedium: p.utmMedium, utmCampaign: p.utmCampaign },
            after: async () => undefined,
        });
    }

    private form(event: InboxRow, p: VslForm): Promise<Applied> {
        const profile = profileFromAnswers(p.answers);
        const temperature = p.temperature ?? null;
        const score = p.score ?? null;
        return this.capture(event, 'FORM', p, `vsl:form:${p.submissionId}`, {
            context: { system: 'VSL_FORM', formSlug: p.formSlug, utmSource: p.utmSource, utmMedium: p.utmMedium, utmCampaign: p.utmCampaign },
            payload: { formSlug: p.formSlug, submission: p.submissionId, score, temperature, utmSource: p.utmSource },
            profile,
            progress: { depth: 'FORM', formScore: score, temperature },
            after: async (leadId) => {
                const saved = await this.leads.saveFormResponse({
                    leadId,
                    formSlug: p.formSlug,
                    submissionRef: p.submissionId,
                    score,
                    temperature,
                    answers: p.answers,
                    submittedAt: p.submittedAt,
                });
                if (saved) {
                    await this.timeline.append({
                        leadId,
                        type: TimelineEvent.FormSubmitted,
                        actorType: 'SOURCE',
                        actorId: null,
                        data: { formSlug: p.formSlug, score, temperature, submission: p.submissionId },
                        occurredAt: p.submittedAt,
                    });
                }
            },
        });
    }

    private booked(event: InboxRow, p: VslBooked): Promise<Applied> {
        return this.capture(event, 'BOOKING', p, `vsl:booking:${p.bookingId}`, {
            context: { system: 'VSL_FORM', formSlug: p.formSlug },
            payload: { booking: p.bookingId, submission: p.submissionId, slot: p.slotLabel },
            progress: { depth: 'BOOKED' },
            after: async (leadId) => {
                const saved = await this.leads.saveBooking({
                    leadId,
                    bookingRef: p.bookingId,
                    submissionRef: p.submissionId,
                    slotStartAt: p.slotStartAt,
                    slotLabel: p.slotLabel,
                });
                // The call time shows on the lead's open opportunity, so "Booked calls" can list it.
                await this.pipeline.setScheduledCall(leadId, p.slotStartAt);
                if (saved) {
                    await this.timeline.append({
                        leadId,
                        type: TimelineEvent.SlotBooked,
                        actorType: 'SOURCE',
                        actorId: null,
                        data: { slot: p.slotLabel, booking: p.bookingId },
                        occurredAt: event.occurredAt,
                    });
                }
            },
        });
    }

    private async completed(p: VslCompleted): Promise<Applied> {
        const booking = await this.leads.findBookingByRef(p.bookingId);
        if (!booking) {
            // The booking event may simply not have been processed yet: try again later.
            throw new Error(`Booking ${p.bookingId} has not reached the CRM yet`);
        }
        const changed = await this.leads.completeBooking(p.bookingId, p.completedAt);
        if (changed) {
            await this.timeline.append({
                leadId: booking.leadId,
                type: TimelineEvent.BookingCompleted,
                actorType: 'SOURCE',
                actorId: null,
                data: { booking: p.bookingId, slot: booking.slotLabel },
                occurredAt: p.completedAt,
            });
        }
        return { leadId: booking.leadId, outcome: 'UPDATED' };
    }

    // ---- shared ----

    /**
     * Finds or makes the person's lead, makes sure it has an open opportunity, moves how far they
     * got forward, and then runs the step's own work. Everything here is safe to repeat, so a retry
     * after a failure finishes what the first try began.
     */
    private async capture(
        event: InboxRow,
        step: Step,
        person: Person,
        ref: string,
        how: {
            context: SourceContext;
            payload: Record<string, unknown>;
            profile?: { currentCompany: string | null; currentCtc: string | null };
            progress?: Parameters<LeadsService['applyVslProgress']>[1];
            after: (leadId: bigint) => Promise<void>;
        },
    ): Promise<Applied> {
        const phone = normalisePhone(person.phone);
        const source = matchSource(await this.leads.listSourceRules(), how.context);
        if (!source) throw new Error('There is no active lead source for VSL leads (add Organic or a VSL source)');

        const fields: ImportedLeadFields = {
            fullName: person.fullName,
            email: person.email,
            phoneE164: phone?.phoneE164 ?? null,
            phoneLast10: phone?.phoneLast10 ?? null,
            currentCompany: how.profile?.currentCompany ?? null,
            currentCtc: how.profile?.currentCtc ?? null,
            graduationYear: null,
            domain: null,
            userType: 'UNKNOWN',
            custom: {},
        };
        const outcome = await this.leads.importLead({
            fields,
            sourceId: source.id,
            ownerId: null,
            listId: null,
            ref,
            handling: 'FILL_EMPTY',
            initialScore: 0,
            kind: step,
            touchpointPayload: { ...how.payload, inboxEvent: event.eventId },
        });
        if (outcome.kind === 'CONFLICT') {
            throw new PermanentIntakeError(
                'IDENTITY_CONFLICT',
                'The email and the phone number belong to two different leads. Merge them, then retry this event',
            );
        }
        const leadId = outcome.kind === 'CREATED' ? outcome.leadId : outcome.match.leadId;
        const isNew = outcome.kind === 'CREATED';
        const resumed = outcome.resumed;

        if (isNew) {
            const entry = {
                leadId,
                type: TimelineEvent.LeadCreated,
                actorType: 'SOURCE' as const,
                actorId: null,
                data: { via: 'VSL', step, sourceId: source.id },
                occurredAt: event.occurredAt,
            };
            if (resumed) await this.timeline.appendOnce(entry);
            else await this.timeline.append(entry);
        } else if (step === 'DETAILS' && !resumed) {
            // Someone already known gave their details again. Later steps say what they did themselves.
            await this.timeline.append({
                leadId,
                type: TimelineEvent.TouchpointAdded,
                actorType: 'SOURCE',
                actorId: null,
                data: { via: 'VSL', step, sourceId: source.id },
                occurredAt: event.occurredAt,
            });
        }

        const state = await this.leads.getVslState(leadId);
        if (state && !ENROLLED.has(state.lifecycleStage)) {
            const opened = await this.pipeline.openOpportunity({ leadId, ownerId: state.ownerId, actorId: null });
            if (opened.created) {
                await this.timeline.append({
                    leadId,
                    type: TimelineEvent.OpportunityOpened,
                    actorType: 'SYSTEM',
                    actorId: null,
                    data: { stage: 'CALL_1_PENDING', opportunity: opened.publicId, via: 'VSL' },
                    occurredAt: event.occurredAt,
                });
            }
        }

        await this.leads.applyVslProgress(leadId, how.progress ?? { depth: 'DETAILS' });
        await how.after(leadId);
        this.logger.debug(`VSL ${step} applied to lead ${leadId}`);
        return { leadId, outcome: isNew ? 'CREATED' : 'UPDATED' };
    }
}
