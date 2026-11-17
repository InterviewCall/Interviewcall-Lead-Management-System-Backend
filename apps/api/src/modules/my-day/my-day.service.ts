import { Injectable } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AssignmentService } from '@modules/assignment';
import { EngagementService } from '@modules/engagement';
import { IamService } from '@modules/iam';
import { LeadsService } from '@modules/leads';
import { addDays, istDateKey, startOfIstDay, startOfIstWeek, WEEKDAY_LABELS } from './ist.js';

const LIST_LIMIT = 50;
/** Managers see the whole team's booked calls and numbers; everyone else sees their own. */
const TEAM_ROLES = ['ADMIN', 'SALES_MANAGER', 'OPS'];

const kindOf = (type: string): 'call' | 'other' => (type === 'DUPLICATE_REVIEW' ? 'other' : 'call');

const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

/**
 * The My day screen: what this person owes today, the booked calls, and the week so far.
 * "Today" is the India day.
 */
@Injectable()
export class MyDayService {
    constructor(
        private readonly engagement: EngagementService,
        private readonly leads: LeadsService,
        private readonly assignment: AssignmentService,
        private readonly iam: IamService,
    ) {}

    async get(auth: AuthContext, view: 'mine' | 'team' = 'mine', now = new Date()) {
        const me = await this.iam.getStaffRef(auth.publicId);
        const team = TEAM_ROLES.includes(auth.role);
        const myId = me?.id ?? null;
        /** A manager can open everyone's follow-ups; the booked calls and numbers are the team's either way. */
        const everyone = team && view === 'team';
        // 0 matches nobody (ids start at 1), for a signed-in person who has no staff row.
        const scopeUserId = team ? null : (myId ?? 0n);

        const today = startOfIstDay(now);
        const tomorrow = addDays(today, 1);
        const yesterday = addDays(today, -1);
        const weekStart = startOfIstWeek(now);
        const windowStart = addDays(today, -13);

        const [due, booked, perDay, newToday, newYesterday] = await Promise.all([
            everyone ? this.engagement.dueTasksOf(null, tomorrow, LIST_LIMIT) : myId === null ? { total: 0, rows: [] } : this.engagement.dueTasksOf(myId, tomorrow, LIST_LIMIT),
            this.engagement.bookedCalls(today, tomorrow, scopeUserId),
            this.engagement.callsPerDay(windowStart, tomorrow, scopeUserId),
            this.newLeads(team, myId, today, now),
            // Yesterday up to the same time of day, so a half-finished day is not compared with a whole one.
            this.newLeads(team, myId, yesterday, new Date(yesterday.getTime() + (now.getTime() - today.getTime()))),
        ]);

        const names = await this.iam.getStaffNames([...booked, ...(everyone ? due.rows : [])].flatMap((b) => (b.assigneeId === null ? [] : [b.assigneeId])));

        const followUps = [...due.rows]
            // Overdue first, then the hottest leads, then the earliest due.
            .sort((a, b) => Number(b.dueAt < now) - Number(a.dueAt < now) || b.lead.priorityRank - a.lead.priorityRank || a.dueAt.getTime() - b.dueAt.getTime())
            .map((t) => ({
                id: String(t.id),
                leadId: t.lead.publicId,
                name: t.lead.fullName,
                type: t.type,
                kind: kindOf(t.type),
                title: t.title,
                dueAt: t.dueAt.toISOString(),
                overdue: t.dueAt.getTime() < now.getTime(),
                attempts: t.lead.attemptCount,
                owner: t.assigneeId === null ? null : (names.get(t.assigneeId) ?? 'A teammate'),
                mine: t.assigneeId !== null && t.assigneeId === myId,
            }));
        const overdue = followUps.filter((f) => f.overdue).length;

        const byDay = new Map(perDay.map((d) => [d.day, d]));
        const week = WEEKDAY_LABELS.map((label, i) => {
            const day = addDays(weekStart, i);
            const found = byDay.get(istDateKey(day));
            return { day: label, date: istDateKey(day), total: found?.total ?? 0, connected: found?.connected ?? 0, today: istDateKey(day) === istDateKey(now) };
        });

        const sum = (from: Date, to: Date) =>
            perDay.filter((d) => d.day >= istDateKey(from) && d.day < istDateKey(to)).reduce((a, d) => ({ total: a.total + d.total, connected: a.connected + d.connected }), { total: 0, connected: 0 });
        const thisWeek = sum(addDays(today, -6), tomorrow);
        const lastWeek = sum(addDays(today, -13), addDays(today, -6));
        const rateNow = percent(thisWeek.connected, thisWeek.total);
        const ratePrev = percent(lastWeek.connected, lastWeek.total);

        return {
            scope: team ? ('team' as const) : ('mine' as const),
            view: everyone ? ('team' as const) : ('mine' as const),
            generatedAt: now.toISOString(),
            kpis: {
                due: due.total,
                overdue,
                booked: booked.length,
                unassigned: team ? booked.filter((b) => b.assigneeId === null).length : null,
                newLeads: newToday,
                newLeadsChange: newYesterday > 0 ? Math.round(((newToday - newYesterday) / newYesterday) * 100) : null,
                connectRate: rateNow,
                connectRateChange: rateNow !== null && ratePrev !== null ? rateNow - ratePrev : null,
            },
            followUps,
            booked: booked.map((b) => ({
                id: String(b.id),
                leadId: b.lead.publicId,
                name: b.lead.fullName,
                detail: [b.lead.currentCompany, b.lead.domain].filter(Boolean).join(' · ') || 'Booked on the VSL',
                startAt: b.dueAt.toISOString(),
                owner: b.assigneeId === null ? null : (names.get(b.assigneeId) ?? 'A teammate'),
                mine: b.assigneeId !== null && b.assigneeId === myId,
            })),
            week,
            weekTotal: week.reduce((n, d) => n + d.total, 0),
        };
    }

    /** Team: leads that first reached the CRM. A person: leads given to them. */
    private newLeads(team: boolean, myId: bigint | null, from: Date, to: Date): Promise<number> {
        if (team) return this.leads.countCaptured(from, to);
        return myId === null ? Promise.resolve(0) : this.assignment.countLeadsGivenTo(myId, from, to);
    }
}
