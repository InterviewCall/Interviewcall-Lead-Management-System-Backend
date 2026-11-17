import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { IamService } from '@modules/iam';
import { addDays, istDateKey, startOfIstWeek } from './ist.js';
import { ReportsRepository } from './reports.repository.js';
import type { ReportQuery } from './reports.schemas.js';
import { FUNNEL_STAGES, type LeadCountRow, type OwnerCountRow, type ReportFilter, SOURCE_GROUPS } from './reports.types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKS = 4;

const sum = (rows: Array<{ count: number }>) => rows.reduce((n, r) => n + r.count, 0);
const countFor = (rows: OwnerCountRow[], id: bigint) => rows.find((r) => r.ownerId === id)?.count ?? 0;
const round1 = (n: number) => Math.round(n * 10) / 10;

function contacted(rows: LeadCountRow[]): { total: number; pct: number | null } {
    const total = rows.reduce((n, r) => n + r.total, 0);
    const eligible = rows.reduce((n, r) => n + r.eligible, 0);
    const done = rows.reduce((n, r) => n + r.contacted, 0);
    return { total, pct: eligible === 0 ? null : round1((done / eligible) * 100) };
}

@Injectable()
export class ReportsService {
    constructor(
        private readonly repository: ReportsRepository,
        private readonly iam: IamService,
    ) {}

    /**
     * The Reports screen for the last `days` days (a rolling window ending now, compared with the same length before
     * it). A BDA gets the same report about their own leads only; everyone else gets the whole team.
     */
    async get(auth: AuthContext, query: ReportQuery) {
        let ownerId: bigint | null = null;
        if (auth.role === 'BDA') {
            const me = await this.iam.getStaffRef(auth.publicId);
            if (!me) throw new ForbiddenException({ code: 'NO_STAFF', message: 'Your account could not be found' });
            ownerId = me.id;
        }
        const f: ReportFilter = { ownerId, group: query.source ?? null };

        const now = new Date();
        const from = new Date(now.getTime() - query.days * DAY_MS);
        const priorFrom = new Date(from.getTime() - query.days * DAY_MS);
        const hourAgo = new Date(now.getTime() - HOUR_MS);
        const firstWeek = addDays(startOfIstWeek(now), -7 * (WEEKS - 1));

        const [leadsNow, leadsPrior, opened, won, furthest, lost, perDay, calls, sources, money] = await Promise.all([
            this.repository.leadsByOwner(from, now, f, hourAgo),
            this.repository.leadsByOwner(priorFrom, from, f, hourAgo),
            this.repository.opportunitiesOpened(from, now, f),
            this.repository.opportunitiesWon(from, now, f),
            this.repository.furthestStages(from, now, f),
            this.repository.lostReasons(from, now, f),
            this.repository.leadsPerDayAndGroup(firstWeek, now, f),
            this.repository.callsByUser(from, now, f),
            this.repository.sourceGroupsInScope(ownerId),
            this.repository.revenue(from, now, f),
        ]);

        const now1 = contacted(leadsNow);
        const prior1 = contacted(leadsPrior);

        // The funnel counts an opportunity at every stage up to the furthest it reached.
        const reached = FUNNEL_STAGES.map((_, i) => furthest.slice(i).reduce((n, c) => n + c, 0));
        const funnel = FUNNEL_STAGES.map((stage, i) => ({
            stage,
            count: reached[i],
            fromPrev: i === 0 || reached[i - 1] === 0 ? null : Math.round((reached[i] / reached[i - 1]) * 100),
        }));

        // Weeks run Monday to Sunday, India time, the last one being this week so far.
        const firstKey = Date.parse(`${istDateKey(firstWeek)}T00:00:00Z`);
        const weeks = Array.from({ length: WEEKS }, (_, i) => ({
            weekStart: istDateKey(addDays(firstWeek, 7 * i)),
            values: Object.fromEntries(SOURCE_GROUPS.map((g) => [g, 0])) as Record<string, number>,
        }));
        for (const row of perDay) {
            const index = Math.floor((Date.parse(`${row.day}T00:00:00Z`) - firstKey) / (7 * DAY_MS));
            if (index >= 0 && index < WEEKS) weeks[index].values[row.group] += row.count;
        }

        // One row per person who owns or calls these leads, plus every active BDA.
        const ids = new Set<bigint>();
        for (const r of [...leadsNow, ...opened, ...won]) if (r.ownerId !== null) ids.add(r.ownerId);
        for (const c of calls) ids.add(c.userId);
        const staff = await this.repository.staffForTable([...ids], ownerId);
        const bdas = staff
            .map((s) => {
                const leads = contacted(leadsNow.filter((r) => r.ownerId === s.id));
                const made = calls.find((c) => c.userId === s.id);
                return {
                    id: s.publicId,
                    name: s.name,
                    leads: leads.total,
                    contactedPct: leads.pct,
                    connectPct: made && made.total > 0 ? round1((made.connected / made.total) * 100) : null,
                    opps: countFor(opened, s.id),
                    won: countFor(won, s.id),
                    revenue: money.filter((m) => m.ownerId === s.id).reduce((n, m) => n + m.fee, 0),
                };
            })
            .sort((a, b) => b.won - a.won || b.opps - a.opps || b.leads - a.leads || a.name.localeCompare(b.name));

        return {
            days: query.days,
            kpis: {
                newLeads: now1.total,
                newLeadsChange: prior1.total === 0 ? null : Math.round(((now1.total - prior1.total) / prior1.total) * 100),
                contactedPct: now1.pct,
                contactedChange: now1.pct !== null && prior1.pct !== null ? round1(now1.pct - prior1.pct) : null,
                opps: sum(opened),
                enrolled: sum(won),
            },
            funnel,
            weeks,
            sources: SOURCE_GROUPS.filter((g) => sources.includes(g)),
            bdas,
            lost: { total: lost.reduce((n, r) => n + r.count, 0), reasons: lost },
            revenue: revenueSummary(money),
        };
    }
}

const PAYMENT_MODES = ['FULL', 'EMI', 'LOAN', 'PART'] as const;

/** The money from won deals: fees agreed, collected, still to collect, and wins with no payment recorded. */
function revenueSummary(rows: Array<{ mode: string | null; deals: number; fee: number; collected: number }>) {
    const recorded = rows.filter((r) => r.mode !== null);
    const booked = recorded.reduce((n, r) => n + r.fee, 0);
    const collected = recorded.reduce((n, r) => n + r.collected, 0);
    const deals = recorded.reduce((n, r) => n + r.deals, 0);
    return {
        booked,
        collected,
        pending: booked - collected,
        averageFee: deals === 0 ? null : Math.round(booked / deals),
        unrecorded: rows.filter((r) => r.mode === null).reduce((n, r) => n + r.deals, 0),
        byMode: PAYMENT_MODES.map((mode) => {
            const of = recorded.filter((r) => r.mode === mode);
            return { mode, deals: of.reduce((n, r) => n + r.deals, 0), booked: of.reduce((n, r) => n + r.fee, 0) };
        }),
    };
}
