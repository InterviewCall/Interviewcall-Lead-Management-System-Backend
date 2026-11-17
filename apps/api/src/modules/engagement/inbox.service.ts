import { Injectable } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { IamService } from '@modules/iam';
import { EngagementRepository } from './engagement.repository.js';
import type { NewNotification } from './engagement.types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A call starting within this long is "soon". */
const SOON = 30 * MINUTE;
/** Follow-ups that fell due longer ago than this are already on My day; they do not alert again. */
const OVERDUE_LOOKBACK = 24 * HOUR;
const OVERDUE_BATCH = 20;
/** A lead that keeps clicking through the VSL alerts its owner once in this long. */
const BACK_ON_VSL_QUIET = 12 * HOUR;
const LIST_SIZE = 30;

const istTime = (at: Date) => at.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });

/**
 * The in-app inbox: what the bell shows. Alerts hold no personal data: the lead's name is looked up when
 * the list is read.
 */
@Injectable()
export class InboxService {
    constructor(
        private readonly repository: EngagementRepository,
        private readonly iam: IamService,
    ) {}

    // ---- who needs to know ----

    /** Someone was given leads. Not worth telling people about leads they gave themselves. */
    async assigned(userId: bigint, leadIds: bigint[]): Promise<void> {
        if (leadIds.length === 0) return;
        await this.repository.insertNotifications([
            {
                userId,
                type: 'NEW_ASSIGNMENT',
                leadId: leadIds.length === 1 ? leadIds[0]! : null,
                message: leadIds.length === 1 ? 'A new lead was assigned to you' : `${leadIds.length} new leads were assigned to you`,
            },
        ]);
    }

    /** A call was booked and nobody owns the lead: every manager is told, once per booked call. */
    async bookedWithoutOwner(leadId: bigint, taskId: bigint): Promise<void> {
        const managers = await this.managers();
        await this.repository.insertNotifications(
            managers.map((userId) => ({ userId, type: 'BOOKED_SLOT_UNASSIGNED', leadId, taskId, message: 'A booked call has no owner yet' })),
        );
    }

    /**
     * A lead the owner is already working booked a call on the VSL. Once per booked call. When the owner's account
     * has been deactivated nobody would see it, so the managers are told instead, like for a lead with no owner.
     */
    async bookedByOwnedLead(leadId: bigint, ownerId: bigint, taskId: bigint): Promise<void> {
        if (!(await this.iam.isActiveStaff(ownerId))) {
            const managers = await this.managers();
            await this.repository.insertNotifications(
                managers.map((userId) => ({ userId, type: 'BOOKED_SLOT_UNASSIGNED', leadId, taskId, message: 'A booked call belongs to someone who has left. Give the lead a new owner' })),
            );
            return;
        }
        await this.repository.insertNotifications([
            { userId: ownerId, type: 'LEAD_REENGAGED', leadId, taskId, message: 'A lead you are working booked a call on the VSL' },
        ]);
    }

    /**
     * A lead that was already in the CRM (a nurturing WorkR lead, say) is back on the VSL. The owner is told;
     * with no owner, the managers. At most once in 12 hours for the same lead, however many VSL steps follow.
     */
    async backOnVsl(leadId: bigint, ownerId: bigint | null, now = new Date()): Promise<void> {
        // An owner who has left cannot act on it: the managers hear instead.
        const owner = ownerId !== null && (await this.iam.isActiveStaff(ownerId)) ? ownerId : null;
        const recipients = owner === null ? await this.managers() : [owner];
        const since = new Date(now.getTime() - BACK_ON_VSL_QUIET);
        const fresh: NewNotification[] = [];
        for (const userId of recipients) {
            if (await this.repository.hasNotificationSince(userId, 'LEAD_REENGAGED', leadId, since)) continue;
            fresh.push({ userId, type: 'LEAD_REENGAGED', leadId, message: owner === null ? (ownerId === null ? 'A lead with no owner is back on the VSL' : 'A lead whose owner has left is back on the VSL') : 'A lead you are nurturing is back on the VSL' });
        }
        await this.repository.insertNotifications(fresh);
    }

    // ---- reading and clearing ----

    /**
     * The bell. First it raises the alerts that depend on the clock (a call starting soon, a follow-up that
     * has just gone overdue) for this person, once per task, then returns the latest alerts and the unread count.
     */
    async list(auth: AuthContext, now = new Date()) {
        const me = await this.iam.getStaffRef(auth.publicId);
        if (!me) return { unread: 0, items: [] };
        await this.raiseTimedAlerts(me.id, now);
        const { unread, rows } = await this.repository.listNotifications(me.id, LIST_SIZE);
        return {
            unread,
            items: rows.map((n) => ({
                id: String(n.id),
                type: n.type,
                message: n.message,
                createdAt: n.createdAt.toISOString(),
                read: n.readAt !== null,
                lead: n.lead ? { id: n.lead.publicId, name: n.lead.fullName } : null,
            })),
        };
    }

    async markRead(auth: AuthContext, id: bigint): Promise<void> {
        const me = await this.iam.getStaffRef(auth.publicId);
        if (me) await this.repository.markNotificationRead(me.id, id);
    }

    async markAllRead(auth: AuthContext): Promise<void> {
        const me = await this.iam.getStaffRef(auth.publicId);
        if (me) await this.repository.markAllNotificationsRead(me.id);
    }

    // ---- internals ----

    private async raiseTimedAlerts(userId: bigint, now: Date): Promise<void> {
        const [soon, overdue] = await Promise.all([
            this.repository.callsStartingBetween(userId, now, new Date(now.getTime() + SOON)),
            this.repository.followUpsFallingDueBetween(userId, new Date(now.getTime() - OVERDUE_LOOKBACK), now, OVERDUE_BATCH),
        ]);
        await this.repository.insertNotifications([
            ...soon.map((t): NewNotification => ({ userId, type: 'SLOT_SOON', leadId: t.leadId, taskId: t.id, message: `A booked call starts at ${istTime(t.dueAt)}` })),
            ...overdue.map((t): NewNotification => ({ userId, type: 'FOLLOWUP_OVERDUE', leadId: t.leadId, taskId: t.id, message: 'A follow-up is overdue' })),
        ]);
    }

    private async managers(): Promise<bigint[]> {
        return (await this.iam.listActiveStaff(['SALES_MANAGER', 'ADMIN'])).map((s) => s.id);
    }
}
