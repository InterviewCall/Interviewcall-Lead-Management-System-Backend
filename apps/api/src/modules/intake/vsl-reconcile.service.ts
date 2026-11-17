import { Injectable, Logger } from '@nestjs/common';
import { EngagementService } from '@modules/engagement';
import { LeadsService } from '@modules/leads';
import { PipelineService } from '@modules/pipeline';

const HOUR = 60 * 60_000;
/** Bookings that changed in this long are looked at again, so a change missed once is caught the next night. */
const LOOKBACK = 3 * 24 * HOUR;
/** A call whose time passed longer ago than this and was never marked done is reported, not changed. */
const OVERDUE_AFTER = 48 * HOUR;
/** A confirmed booking with no task is given one only while the call is recent or ahead; an old one would only clutter My day. */
const TASK_GRACE = 24 * HOUR;

const ENROLLED = new Set(['ENROLLED', 'LEARNER_ONBOARDED']);

export interface ReconcileReport {
    ranAt: string;
    bookingsChecked: number;
    tasksCreated: number;
    tasksRetimed: number;
    tasksClosed: number;
    leadsRefreshed: number;
    /** Confirmed calls that took place long ago and were never marked done on the VSL: someone should look. */
    callsNeverMarkedDone: number;
}

/**
 * The nightly check that the CRM's picture of the booked calls matches itself. Events can be lost, arrive late or fail
 * half-way, so each night every confirmed booking, and every booking that changed in the last 3 days, is compared with
 * its call task and the lead's booked time, and what differs is repaired. It only ever makes things agree with the
 * booking: a task a person closed by hand while the booking is still confirmed is left alone. Safe to run any time.
 */
@Injectable()
export class VslReconcileService {
    private readonly logger = new Logger(VslReconcileService.name);

    constructor(
        private readonly leads: LeadsService,
        private readonly engagement: EngagementService,
        private readonly pipeline: PipelineService,
    ) {}

    async run(now = new Date()): Promise<ReconcileReport> {
        const report: ReconcileReport = {
            ranAt: now.toISOString(),
            bookingsChecked: 0,
            tasksCreated: 0,
            tasksRetimed: 0,
            tasksClosed: 0,
            leadsRefreshed: 0,
            callsNeverMarkedDone: 0,
        };
        const bookings = await this.leads.listBookingsToCheck(new Date(now.getTime() - LOOKBACK));
        report.bookingsChecked = bookings.length;
        const tasks = await this.engagement.scheduledCallStates(bookings.map((b) => b.bookingRef));

        const withConfirmed = new Set<bigint>();
        const withCancelled = new Set<bigint>();
        for (const booking of bookings) {
            const task = tasks.get(booking.bookingRef);
            if (booking.status === 'CONFIRMED') {
                withConfirmed.add(booking.leadId);
                if (now.getTime() - booking.slotStartAt.getTime() > OVERDUE_AFTER) report.callsNeverMarkedDone++;
                if (!task) {
                    if (ENROLLED.has(booking.lifecycleStage) || now.getTime() - booking.slotStartAt.getTime() > TASK_GRACE) continue;
                    await this.engagement.openScheduledCall({
                        leadId: booking.leadId,
                        ownerId: booking.ownerId,
                        bookingRef: booking.bookingRef,
                        slotStartAt: booking.slotStartAt,
                        slotLabel: booking.slotLabel,
                    });
                    report.tasksCreated++;
                } else if (task.status === 'OPEN' && task.dueAt.getTime() !== booking.slotStartAt.getTime()) {
                    await this.engagement.retimeScheduledCall(task.id, booking.slotStartAt, booking.slotLabel);
                    report.tasksRetimed++;
                }
            } else if (task?.status === 'OPEN') {
                if (booking.status === 'COMPLETED') await this.engagement.completeScheduledCall(booking.bookingRef, now);
                else await this.engagement.cancelScheduledCall(booking.bookingRef, now);
                report.tasksClosed++;
            }
            if (booking.status === 'CANCELLED') withCancelled.add(booking.leadId);
        }

        // The lead's booked time follows its confirmed bookings; a lead with only cancelled ones has none.
        for (const leadId of withConfirmed) {
            const next = await this.leads.nextConfirmedSlot(leadId, now);
            if (await this.pipeline.setScheduledCall(leadId, next)) report.leadsRefreshed++;
        }
        for (const leadId of withCancelled) {
            if (withConfirmed.has(leadId)) continue;
            await this.leads.settleVslDepth(leadId);
            if (await this.pipeline.setScheduledCall(leadId, await this.leads.nextConfirmedSlot(leadId, now))) report.leadsRefreshed++;
        }

        this.logger.log(`VSL reconcile: ${JSON.stringify(report)}`);
        return report;
    }
}
