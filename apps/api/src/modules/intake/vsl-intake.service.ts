import { Injectable, Logger } from '@nestjs/common';
import { EngagementService, InboxService } from '@modules/engagement';
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
    type VslCancelled,
    type VslCompleted,
    type VslDetails,
    type VslForm,
    type VslReopened,
    type VslRescheduled,
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
        private readonly engagement: EngagementService,
        private readonly inbox: InboxService,
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
            case 'vsl.booking_cancelled':
                return this.cancelled(this.parse<VslCancelled>(event));
            case 'vsl.booking_rescheduled':
                return this.rescheduled(this.parse<VslRescheduled>(event));
            case 'vsl.booking_reopened':
                return this.reopened(this.parse<VslReopened>(event));
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
                // The header score rule: the lead's score carries the newest form's score. Safe to repeat.
                if (score !== null) await this.leads.applyFormScore(leadId, p.submissionId, score);
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
                // And it is a task for the lead's owner, due at the slot.
                const state = await this.leads.getVslState(leadId);
                const call = await this.engagement.openScheduledCall({
                    leadId,
                    ownerId: state?.ownerId ?? null,
                    bookingRef: p.bookingId,
                    slotStartAt: p.slotStartAt,
                    slotLabel: p.slotLabel,
                });
                // The owner hears about it; with no owner, the managers do. Learners already enrolled are not leads.
                if (state && !ENROLLED.has(state.lifecycleStage)) {
                    if (state.ownerId === null) await this.inbox.bookedWithoutOwner(leadId, call.id);
                    else await this.inbox.bookedByOwnedLead(leadId, state.ownerId, call.id);
                }
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
        await this.engagement.completeScheduledCall(p.bookingId, p.completedAt);
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

    /** The booking was cancelled: the call is no longer coming, so its task, alerts and booked time go. */
    private async cancelled(p: VslCancelled): Promise<Applied> {
        const booking = await this.requireBooking(p.bookingId);
        const changed = await this.leads.cancelBooking(p.bookingId, p.cancelledAt, p.cancelSource ?? null);
        // A call that was already held is not undone by a late cancellation.
        if (changed || booking.status === 'CANCELLED') {
            await this.engagement.cancelScheduledCall(p.bookingId, p.cancelledAt);
            await this.leads.settleVslDepth(booking.leadId);
            await this.refreshBookedTime(booking.leadId);
        }
        if (changed) {
            await this.timeline.append({
                leadId: booking.leadId,
                type: TimelineEvent.BookingCancelled,
                actorType: 'SOURCE',
                actorId: null,
                data: { booking: p.bookingId, slot: booking.slotLabel, by: p.cancelSource ?? null },
                occurredAt: p.cancelledAt,
            });
        }
        return { leadId: booking.leadId, outcome: 'UPDATED' };
    }

    /** The call moved: the booking, its task and the lead's booked time follow, and the "starting soon" alert can fire again. */
    private async rescheduled(p: VslRescheduled): Promise<Applied> {
        const booking = await this.requireBooking(p.bookingId);
        // A call that was cancelled or already held does not move.
        if (booking.status !== 'CONFIRMED') return { leadId: booking.leadId, outcome: 'UPDATED' };
        const changed = await this.leads.rescheduleBooking(p.bookingId, p.slotStartAt, p.slotLabel);
        const moved = await this.engagement.rescheduleScheduledCall(p.bookingId, p.slotStartAt, p.slotLabel);
        if (moved === null) {
            // No open task to move: the event may have outrun the booking's own task, so make it (a task someone closed stays closed).
            const state = await this.leads.getVslState(booking.leadId);
            if (state && !ENROLLED.has(state.lifecycleStage)) {
                await this.engagement.openScheduledCall({
                    leadId: booking.leadId,
                    ownerId: state.ownerId,
                    bookingRef: p.bookingId,
                    slotStartAt: p.slotStartAt,
                    slotLabel: p.slotLabel,
                });
            }
        }
        await this.refreshBookedTime(booking.leadId);
        if (changed) {
            await this.timeline.append({
                leadId: booking.leadId,
                type: TimelineEvent.BookingRescheduled,
                actorType: 'SOURCE',
                actorId: null,
                data: { booking: p.bookingId, slot: p.slotLabel, was: booking.slotLabel },
                occurredAt: new Date(),
            });
        }
        return { leadId: booking.leadId, outcome: 'UPDATED' };
    }

    /** "Call done" was taken back: the booking is confirmed again and its task is open again. */
    private async reopened(p: VslReopened): Promise<Applied> {
        const booking = await this.requireBooking(p.bookingId);
        const changed = await this.leads.reopenBooking(p.bookingId, p.reopenedAt ?? null);
        if (changed || booking.status === 'CONFIRMED') {
            await this.engagement.reopenScheduledCall(p.bookingId);
            await this.refreshBookedTime(booking.leadId);
        }
        if (changed) {
            await this.timeline.append({
                leadId: booking.leadId,
                type: TimelineEvent.BookingReopened,
                actorType: 'SOURCE',
                actorId: null,
                data: { booking: p.bookingId, slot: booking.slotLabel },
                occurredAt: new Date(),
            });
        }
        return { leadId: booking.leadId, outcome: 'UPDATED' };
    }

    /** The booking an event is about. It may simply not have been processed yet, so a missing one is tried again later. */
    private async requireBooking(bookingRef: string) {
        const booking = await this.leads.findBookingByRef(bookingRef);
        if (!booking) throw new Error(`Booking ${bookingRef} has not reached the CRM yet`);
        return booking;
    }

    /** The lead's open opportunity shows the time of the call the lead is waiting for (or none). */
    private async refreshBookedTime(leadId: bigint): Promise<void> {
        await this.pipeline.setScheduledCall(leadId, await this.leads.nextConfirmedSlot(leadId));
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
        // Someone already in the CRM (a nurturing WorkR lead, say) has reached the VSL for the first time. A booking has
        // its own alert, and a person who started on the VSL is not "back": their later steps are just the next steps.
        if (!isNew && step !== 'BOOKING' && state && state.vslDepth === 'NONE' && !ENROLLED.has(state.lifecycleStage)) {
            await this.inbox.backOnVsl(leadId, state.ownerId);
        }
        this.logger.debug(`VSL ${step} applied to lead ${leadId}`);
        return { leadId, outcome: isNew ? 'CREATED' : 'UPDATED' };
    }
}
