import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService } from '@modules/admin';
import { IamService } from '@modules/iam';
import { ReportsRepository } from './reports.repository.js';
import type { ReportQuery } from './reports.schemas.js';
import { FUNNEL_STAGES, type FirstTouchRow, type ReportFilter, SOURCE_GROUPS } from './reports.types.js';

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Wait buckets for "how soon was a new lead first touched", in seconds. */
const BUCKETS = [
    { key: 'within15m', label: 'Within 15 minutes', upTo: 15 * 60 },
    { key: 'within1h', label: '15 minutes to 1 hour', upTo: 60 * 60 },
    { key: 'within4h', label: '1 to 4 hours', upTo: 4 * 3600 },
    { key: 'within24h', label: '4 to 24 hours', upTo: 24 * 3600 },
    { key: 'later', label: 'Over a day', upTo: Infinity },
] as const;

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** How far from an even share a person's leads may be before the fairness report flags it. */
const FAIRNESS_TOLERANCE_PCT = 25;
/** Below this many leads per person on average, the shares are too small to judge. */
const FAIRNESS_MIN_PER_PERSON = 4;

/**
 * The three operations reports: how fast new leads are first touched, how long open opportunities sit in a stage, and
 * how evenly leads were handed out. The first and the third follow the date range; stage aging is the state right now.
 * A BDA sees their own figures for the first two and nothing for fairness.
 */
@Injectable()
export class OperationsService {
    constructor(
        private readonly repository: ReportsRepository,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

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
        const [targetMinutes, staleDays] = await Promise.all([
            this.admin.getSetting('reports.firstResponseTargetMinutes'),
            this.admin.getSetting('reports.stageStaleDays'),
        ]);

        const [touches, aging, stuck, assigned, bdas] = await Promise.all([
            this.repository.firstTouches(from, now, f),
            this.repository.stageAging(f, staleDays),
            this.repository.longestStuck(f, 8),
            ownerId === null ? this.repository.assignedTo(from, now, f.group) : Promise.resolve([]),
            ownerId === null ? this.repository.activeBdas() : Promise.resolve([]),
        ]);

        return {
            days: query.days,
            firstResponse: this.firstResponse(touches, targetMinutes),
            stageAging: {
                staleDays,
                stages: FUNNEL_STAGES.filter((s) => s !== 'CLOSED_WON').map((stage) => {
                    const row = aging.find((a) => a.stage === stage);
                    return { stage, open: row?.open ?? 0, avgDays: row ? round1(row.avgDays) : 0, maxDays: row ? Math.floor(row.maxDays) : 0, stale: row?.stale ?? 0 };
                }),
                longest: stuck.map((s) => ({ ...s, days: Math.floor(s.days) })),
            },
            fairness: ownerId === null ? this.fairness(assigned, bdas) : null,
        };
    }

    private firstResponse(rows: FirstTouchRow[], targetMinutes: number) {
        const target = targetMinutes * 60;
        // A lead can be judged once it was touched, or once the target has passed without a touch.
        const judged = rows.filter((r) => r.seconds !== null || r.ageSeconds >= target);
        const within = judged.filter((r) => r.seconds !== null && r.seconds <= target).length;
        const touched = rows.filter((r) => r.seconds !== null).map((r) => r.seconds as number);
        const waiting = rows.filter((r) => r.seconds === null && r.ageSeconds >= target).length;
        const med = median(touched);
        return {
            targetMinutes,
            leads: rows.length,
            judged: judged.length,
            withinTarget: within,
            pct: judged.length === 0 ? null : round1((within / judged.length) * 100),
            medianMinutes: med === null ? null : round1(med / 60),
            waiting,
            buckets: [
                ...BUCKETS.map((b, i) => {
                    const lower = i === 0 ? -1 : BUCKETS[i - 1].upTo;
                    return { key: b.key, label: b.label, count: touched.filter((s) => s > lower && s <= b.upTo).length };
                }),
                { key: 'none', label: 'Not touched yet', count: rows.filter((r) => r.seconds === null).length },
            ],
            byGroup: SOURCE_GROUPS.map((group) => {
                const own = rows.filter((r) => r.group === group);
                const j = own.filter((r) => r.seconds !== null || r.ageSeconds >= target);
                const w = j.filter((r) => r.seconds !== null && r.seconds <= target).length;
                const m = median(own.filter((r) => r.seconds !== null).map((r) => r.seconds as number));
                return { group, leads: own.length, pct: j.length === 0 ? null : round1((w / j.length) * 100), medianMinutes: m === null ? null : round1(m / 60) };
            }).filter((g) => g.leads > 0),
        };
    }

    private fairness(assigned: Array<{ userId: bigint; assigned: number; hot: number; deepVsl: number }>, bdas: Array<{ id: bigint; publicId: string; name: string }>) {
        const rows = bdas.map((b) => {
            const a = assigned.find((x) => x.userId === b.id);
            return { id: b.publicId, name: b.name, assigned: a?.assigned ?? 0, hot: a?.hot ?? 0, deepVsl: a?.deepVsl ?? 0 };
        });
        const total = rows.reduce((n, r) => n + r.assigned, 0);
        const expected = rows.length === 0 ? 0 : total / rows.length;
        const judgeable = rows.length > 1 && expected >= FAIRNESS_MIN_PER_PERSON;
        const out = rows
            .map((r) => {
                const deviation = judgeable ? round1((r.assigned / expected - 1) * 100) : null;
                return {
                    ...r,
                    sharePct: total === 0 ? 0 : round1((r.assigned / total) * 100),
                    hotPct: r.assigned === 0 ? null : round1((r.hot / r.assigned) * 100),
                    deepVslPct: r.assigned === 0 ? null : round1((r.deepVsl / r.assigned) * 100),
                    deviationPct: deviation,
                    flag: deviation === null || Math.abs(deviation) <= FAIRNESS_TOLERANCE_PCT ? null : deviation > 0 ? ('over' as const) : ('under' as const),
                };
            })
            .sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
        return { total, expectedEach: round1(expected), tolerancePct: FAIRNESS_TOLERANCE_PCT, judgeable, people: out };
    }
}
