import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import type { OutcomeEffect } from './engagement.schemas.js';
import type { BookedCallRow, DayTaskRow, NewActivity, NewNotification, NotificationRow, OutcomeAdminRow, OutcomeRow, TaskAlertRow, TaskRow, TaskStatusName } from './engagement.types.js';

/**
 * The only class allowed to read or write this module's tables:
 * outcomes, activities, tasks, notifications.
 * Other modules call EngagementService instead of touching these models.
 */
@Injectable()
export class EngagementRepository {
    constructor(private readonly db: ModelService) {}

    // ---- outcomes ----

    listOutcomes(): Promise<OutcomeRow[]> {
        return this.db.outcome.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true, effect: true, requiresFollowup: true },
        });
    }

    async listOutcomesForAdmin(): Promise<OutcomeAdminRow[]> {
        const rows = await this.db.outcome.findMany({
            orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            select: { id: true, name: true, effect: true, requiresFollowup: true, isActive: true, sortOrder: true, _count: { select: { activities: true } } },
        });
        return rows.map(({ _count, ...r }) => ({ ...r, used: _count.activities }));
    }

    findOutcomeAnyState(id: number) {
        return this.db.outcome.findUnique({ where: { id }, select: { id: true, name: true, effect: true, requiresFollowup: true, isActive: true, sortOrder: true } });
    }

    findOutcomeNameTaken(name: string, exceptId?: number) {
        return this.db.outcome.findFirst({ where: { name, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    }

    async nextOutcomeOrder(): Promise<number> {
        const top = await this.db.outcome.aggregate({ _max: { sortOrder: true } });
        return (top._max.sortOrder ?? -1) + 1;
    }

    async createOutcome(data: { name: string; effect: OutcomeEffect; requiresFollowup: boolean; sortOrder: number }): Promise<number> {
        return (await this.db.outcome.create({ data: { ...data, effect: data.effect as Prisma.InputJsonObject }, select: { id: true } })).id;
    }

    async updateOutcome(id: number, data: { name?: string; effect?: OutcomeEffect; requiresFollowup?: boolean; isActive?: boolean; sortOrder?: number }): Promise<void> {
        await this.db.outcome.update({ where: { id }, data: { ...data, ...(data.effect ? { effect: data.effect as Prisma.InputJsonObject } : {}) } });
    }

    findOutcome(id: number): Promise<OutcomeRow | null> {
        return this.db.outcome.findFirst({
            where: { id, isActive: true },
            select: { id: true, name: true, effect: true, requiresFollowup: true },
        });
    }

    // ---- activities ----

    async createActivity(input: NewActivity): Promise<bigint> {
        const row = await this.db.activity.create({ data: input, select: { id: true } });
        return row.id;
    }

    async hasConnectedActivity(leadId: bigint): Promise<boolean> {
        return (await this.db.activity.count({ where: { leadId, connected: true } })) > 0;
    }

    listActivities(leadId: bigint, take: number) {
        return this.db.activity.findMany({
            where: { leadId },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
                id: true,
                kind: true,
                connected: true,
                attemptNo: true,
                notes: true,
                nextFollowupAt: true,
                occurredAt: true,
                userId: true,
                outcome: { select: { id: true, name: true } },
            },
        });
    }

    // ---- tasks ----

    async createTask(input: {
        leadId: bigint;
        assigneeId: bigint | null;
        type: 'FOLLOW_UP' | 'SCHEDULED_CALL';
        title: string;
        dueAt: Date;
        createdById: bigint | null;
        bookingRef?: string;
    }): Promise<bigint> {
        const row = await this.db.task.create({ data: input, select: { id: true } });
        return row.id;
    }

    findTask(id: bigint): Promise<TaskRow | null> {
        return this.db.task.findUnique({
            where: { id },
            select: {
                id: true,
                leadId: true,
                assigneeId: true,
                type: true,
                status: true,
                title: true,
                dueAt: true,
                completedAt: true,
                lead: { select: { publicId: true } },
            },
        }) as Promise<TaskRow | null>;
    }

    /** Open tasks of the lead (earliest first), and the few most recent finished ones. */
    async listTasks(leadId: bigint): Promise<TaskRow[]> {
        const select = {
            id: true,
            leadId: true,
            assigneeId: true,
            type: true,
            status: true,
            title: true,
            dueAt: true,
            completedAt: true,
            lead: { select: { publicId: true } },
        } as const;
        const [open, closed] = await Promise.all([
            this.db.task.findMany({
                where: { leadId, status: 'OPEN', type: { in: ['FOLLOW_UP', 'SCHEDULED_CALL'] } },
                orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
                select,
            }),
            this.db.task.findMany({
                where: { leadId, status: { in: ['DONE', 'CANCELLED'] }, type: { in: ['FOLLOW_UP', 'SCHEDULED_CALL'] } },
                orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
                take: 10,
                select,
            }),
        ]);
        return [...open, ...closed] as TaskRow[];
    }

    /** Moves an open task to DONE or CANCELLED. False when it was not open any more. */
    async closeTask(id: bigint, status: Exclude<TaskStatusName, 'OPEN'>, at: Date): Promise<boolean> {
        const { count } = await this.db.task.updateMany({ where: { id, status: 'OPEN' }, data: { status, completedAt: at } });
        return count === 1;
    }

    /** Changes an open follow-up. False when it was closed in the meantime. */
    async updateOpenTask(id: bigint, data: { title?: string; dueAt?: Date; assigneeId?: bigint }): Promise<boolean> {
        const { count } = await this.db.task.updateMany({ where: { id, status: 'OPEN' }, data });
        return count === 1;
    }

    /** Closes every open follow-up of the lead (a logged call answers them). Returns how many. */
    async closeOpenFollowups(leadId: bigint, status: Exclude<TaskStatusName, 'OPEN'>, at: Date): Promise<number> {
        const { count } = await this.db.task.updateMany({
            where: { leadId, type: 'FOLLOW_UP', status: 'OPEN' },
            data: { status, completedAt: at },
        });
        return count;
    }

    async earliestOpenFollowup(leadId: bigint): Promise<Date | null> {
        const row = await this.db.task.findFirst({
            where: { leadId, type: 'FOLLOW_UP', status: 'OPEN' },
            orderBy: { dueAt: 'asc' },
            select: { dueAt: true },
        });
        return row?.dueAt ?? null;
    }

    /** One task per booking: asking again for the same booking only refreshes it. */
    async upsertScheduledCall(input: {
        leadId: bigint;
        bookingRef: string;
        title: string;
        dueAt: Date;
        assigneeId: bigint | null;
    }): Promise<{ id: bigint; created: boolean }> {
        const existing = await this.db.task.findUnique({ where: { bookingRef: input.bookingRef }, select: { id: true, status: true } });
        if (existing) {
            if (existing.status === 'OPEN') {
                await this.db.task.update({ where: { id: existing.id }, data: { dueAt: input.dueAt, title: input.title } });
            }
            return { id: existing.id, created: false };
        }
        const task = await this.db.task.create({
            data: { leadId: input.leadId, assigneeId: input.assigneeId, type: 'SCHEDULED_CALL', title: input.title, dueAt: input.dueAt, bookingRef: input.bookingRef },
            select: { id: true },
        });
        return { id: task.id, created: true };
    }

    async closeScheduledCall(bookingRef: string, at: Date): Promise<boolean> {
        const { count } = await this.db.task.updateMany({
            where: { bookingRef, status: 'OPEN' },
            data: { status: 'DONE', completedAt: at },
        });
        return count === 1;
    }

    /** A cancelled booking takes its open task with it and quietly clears the alerts about it. Returns whether a task was open. */
    async cancelScheduledCall(bookingRef: string, at: Date): Promise<boolean> {
        const task = await this.db.task.findUnique({ where: { bookingRef }, select: { id: true, status: true } });
        if (!task) return false;
        await this.db.notification.updateMany({ where: { taskId: task.id, readAt: null }, data: { readAt: at } });
        if (task.status !== 'OPEN') return false;
        await this.db.task.update({ where: { id: task.id }, data: { status: 'CANCELLED', completedAt: at } });
        return true;
    }

    /**
     * The call moved: the open task moves with it. The "starting soon" alert is cleared so it can fire again for the
     * new time. Returns the task's id, or null when there is no task or it is no longer open.
     */
    async moveScheduledCall(bookingRef: string, dueAt: Date, title: string): Promise<bigint | null> {
        const task = await this.db.task.findUnique({ where: { bookingRef }, select: { id: true, status: true } });
        if (!task || task.status !== 'OPEN') return null;
        await this.db.task.update({ where: { id: task.id }, data: { dueAt, title } });
        await this.db.notification.deleteMany({ where: { taskId: task.id, type: 'SLOT_SOON' } });
        return task.id;
    }

    /** The VSL un-marked the call as done: its task is open again. False when there was no done task. */
    async reopenScheduledCall(bookingRef: string): Promise<boolean> {
        const { count } = await this.db.task.updateMany({
            where: { bookingRef, status: 'DONE' },
            data: { status: 'OPEN', completedAt: null },
        });
        return count === 1;
    }

    /** What the scheduled-call tasks of these bookings look like now, for the nightly check. */
    async scheduledCallStates(bookingRefs: string[]): Promise<Map<string, { id: bigint; status: TaskStatusName; dueAt: Date; assigneeId: bigint | null }>> {
        const found = new Map<string, { id: bigint; status: TaskStatusName; dueAt: Date; assigneeId: bigint | null }>();
        for (let i = 0; i < bookingRefs.length; i += 1000) {
            const rows = await this.db.task.findMany({
                where: { bookingRef: { in: bookingRefs.slice(i, i + 1000) } },
                select: { id: true, bookingRef: true, status: true, dueAt: true, assigneeId: true },
            });
            for (const row of rows) if (row.bookingRef) found.set(row.bookingRef, row);
        }
        return found;
    }

    /** Sets the due time and title of an open scheduled-call task. */
    async retimeScheduledCall(taskId: bigint, dueAt: Date, title: string): Promise<void> {
        await this.db.task.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { dueAt, title } });
        await this.db.notification.deleteMany({ where: { taskId, type: 'SLOT_SOON' } });
    }

    /** The open follow-ups and scheduled calls of these leads belong to `assigneeId` now. */
    async moveLeadRecords(fromLeadId: bigint, toLeadId: bigint): Promise<void> {
        await this.db.$transaction([
            this.db.activity.updateMany({ where: { leadId: fromLeadId }, data: { leadId: toLeadId } }),
            this.db.task.updateMany({ where: { leadId: fromLeadId }, data: { leadId: toLeadId } }),
            this.db.notification.updateMany({ where: { leadId: fromLeadId }, data: { leadId: toLeadId } }),
        ]);
    }

    /** Erasure: free-text notes, task wording and alert text go; open follow-ups are cancelled. Counts and times stay for the reports. */
    async eraseLeadRecords(leadId: bigint, at: Date): Promise<void> {
        await this.db.$transaction([
            this.db.activity.updateMany({ where: { leadId }, data: { notes: null } }),
            this.db.task.updateMany({ where: { leadId, status: 'OPEN' }, data: { status: 'CANCELLED', completedAt: at } }),
            this.db.task.updateMany({ where: { leadId }, data: { title: 'Task' } }),
            this.db.notification.updateMany({ where: { leadId }, data: { message: 'A lead was anonymised' } }),
        ]);
    }

    async reassignOpenTasks(leadIds: bigint[], assigneeId: bigint): Promise<void> {
        for (let i = 0; i < leadIds.length; i += 500) {
            await this.db.task.updateMany({
                where: { leadId: { in: leadIds.slice(i, i + 500) }, status: 'OPEN', type: { in: ['FOLLOW_UP', 'SCHEDULED_CALL'] } },
                data: { assigneeId },
            });
        }
    }

    // ---- the My day view ----

    /** Open tasks of one person due before `before` (overdue ones included), earliest first. */
    async listDueTasks(assigneeId: bigint | null, before: Date, take: number): Promise<{ total: number; rows: DayTaskRow[] }> {
        const where = { ...(assigneeId === null ? {} : { assigneeId }), status: 'OPEN' as const, dueAt: { lt: before }, type: { in: ['FOLLOW_UP', 'SCHEDULED_CALL', 'DUPLICATE_REVIEW'] as Array<'FOLLOW_UP' | 'SCHEDULED_CALL' | 'DUPLICATE_REVIEW'> } };
        const [total, rows] = await Promise.all([
            this.db.task.count({ where }),
            this.db.task.findMany({
                where,
                orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
                take,
                select: { id: true, type: true, title: true, dueAt: true, assigneeId: true, lead: { select: { publicId: true, fullName: true, priorityRank: true, attemptCount: true } } },
            }),
        ]);
        return { total, rows };
    }

    /** Scheduled calls still open whose slot falls in [from, to). `assigneeId` limits them to one person. */
    listBookedCalls(from: Date, to: Date, assigneeId: bigint | null): Promise<BookedCallRow[]> {
        return this.db.task.findMany({
            where: { type: 'SCHEDULED_CALL', status: 'OPEN', dueAt: { gte: from, lt: to }, ...(assigneeId === null ? {} : { assigneeId }) },
            orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
            take: 100,
            select: {
                id: true,
                dueAt: true,
                assigneeId: true,
                lead: { select: { publicId: true, fullName: true, currentCompany: true, domain: true } },
            },
        });
    }

    /**
     * Calls per India-time day in [from, to): how many, and how many were answered.
     * India has no daylight saving, so a fixed +05:30 offset cuts the days correctly.
     */
    async callsPerDay(from: Date, to: Date, userId: bigint | null): Promise<Array<{ day: string; total: number; connected: number }>> {
        const rows = await this.db.$queryRaw<Array<{ day: string; total: bigint; connected: bigint }>>(Prisma.sql`
            SELECT DATE_FORMAT(DATE_ADD(occurred_at, INTERVAL 330 MINUTE), '%Y-%m-%d') AS day,
                   COUNT(*) AS total,
                   CAST(COALESCE(SUM(connected = 1), 0) AS UNSIGNED) AS connected
            FROM activities
            WHERE kind = 'CALL' AND occurred_at >= ${from} AND occurred_at < ${to}
              ${userId === null ? Prisma.empty : Prisma.sql`AND user_id = ${userId}`}
            GROUP BY day`);
        return rows.map((r) => ({ day: r.day, total: Number(r.total), connected: Number(r.connected) }));
    }

    // ---- notifications (the in-app inbox) ----

    /** Writes the alerts; one that this person already has for the same task is skipped. */
    async insertNotifications(rows: NewNotification[]): Promise<void> {
        if (rows.length === 0) return;
        await this.db.notification.createMany({
            data: rows.map((r) => ({ userId: r.userId, type: r.type, leadId: r.leadId ?? null, taskId: r.taskId ?? null, message: r.message })),
            skipDuplicates: true,
        });
    }

    async hasNotificationSince(userId: bigint, type: NewNotification['type'], leadId: bigint, since: Date): Promise<boolean> {
        const found = await this.db.notification.findFirst({ where: { userId, type, leadId, createdAt: { gte: since } }, select: { id: true } });
        return found !== null;
    }

    async listNotifications(userId: bigint, take: number): Promise<{ unread: number; rows: NotificationRow[] }> {
        const [unread, rows] = await Promise.all([
            this.db.notification.count({ where: { userId, readAt: null } }),
            this.db.notification.findMany({
                where: { userId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take,
                select: { id: true, type: true, message: true, readAt: true, createdAt: true, lead: { select: { publicId: true, fullName: true } } },
            }),
        ]);
        return { unread, rows };
    }

    async markNotificationRead(userId: bigint, id: bigint): Promise<void> {
        await this.db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    }

    async markAllNotificationsRead(userId: bigint): Promise<void> {
        await this.db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    }

    /** This person's open booked calls starting between `from` and `to`. */
    callsStartingBetween(userId: bigint, from: Date, to: Date): Promise<TaskAlertRow[]> {
        return this.db.task.findMany({
            where: { assigneeId: userId, type: 'SCHEDULED_CALL', status: 'OPEN', dueAt: { gte: from, lt: to } },
            orderBy: { dueAt: 'asc' },
            take: 20,
            select: { id: true, leadId: true, dueAt: true },
        });
    }

    /** This person's open follow-ups that fell due between `from` and `to`, most recent first. */
    followUpsFallingDueBetween(userId: bigint, from: Date, to: Date, take: number): Promise<TaskAlertRow[]> {
        return this.db.task.findMany({
            where: { assigneeId: userId, type: 'FOLLOW_UP', status: 'OPEN', dueAt: { gte: from, lt: to } },
            orderBy: { dueAt: 'desc' },
            take,
            select: { id: true, leadId: true, dueAt: true },
        });
    }
}
