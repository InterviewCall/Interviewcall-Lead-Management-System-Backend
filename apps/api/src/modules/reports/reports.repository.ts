import { Injectable } from '@nestjs/common';
import { ModelService } from '@app/model';
import { Prisma } from '@app/prisma';
import {
    type AssignedRow,
    type CallCountRow,
    type FirstTouchRow,
    FUNNEL_STAGES,
    type LeadCountRow,
    type OwnerCountRow,
    type ReportFilter,
    type SourceGroupName,
    type StaffRow,
    type StageAgeRow,
    type StuckRow,
} from './reports.types.js';

const num = (value: bigint | number | null | undefined): number => Number(value ?? 0);

/**
 * Read-only aggregates for the Reports screen. It reads across the lead, opportunity and activity tables and
 * writes nothing; every query is narrowed by the same filter (a BDA's own leads, one source group).
 */
@Injectable()
export class ReportsRepository {
    constructor(private readonly db: ModelService) {}

    /** The leads that count: not merged away, not anonymised, inside the filter. Needs `leads l` and `lead_sources s`. */
    private scope(f: ReportFilter): Prisma.Sql {
        return Prisma.sql`l.merged_into_id IS NULL AND l.anonymised_at IS NULL
            ${f.ownerId === null ? Prisma.empty : Prisma.sql`AND l.owner_id = ${f.ownerId}`}
            ${f.group === null ? Prisma.empty : Prisma.sql`AND s.\`group\` = ${f.group}`}`;
    }

    /** Leads captured in [from, to), per owner, with how many were contacted within an hour of arriving. */
    async leadsByOwner(from: Date, to: Date, f: ReportFilter, hourAgo: Date): Promise<LeadCountRow[]> {
        const rows = await this.db.$queryRaw<Array<{ owner_id: bigint | null; total: bigint; eligible: bigint | null; contacted: bigint | null }>>(Prisma.sql`
            SELECT l.owner_id,
                   COUNT(*) AS total,
                   CAST(SUM(l.captured_at <= ${hourAgo}
                            OR (l.first_touch_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, l.captured_at, l.first_touch_at) <= 3600)) AS UNSIGNED) AS eligible,
                   CAST(SUM(l.first_touch_at IS NOT NULL AND TIMESTAMPDIFF(SECOND, l.captured_at, l.first_touch_at) <= 3600) AS UNSIGNED) AS contacted
            FROM leads l JOIN lead_sources s ON s.id = l.first_source_id
            WHERE l.captured_at >= ${from} AND l.captured_at < ${to} AND ${this.scope(f)}
            GROUP BY l.owner_id`);
        return rows.map((r) => ({ ownerId: r.owner_id, total: num(r.total), eligible: num(r.eligible), contacted: num(r.contacted) }));
    }

    /** Opportunities opened in [from, to), per owner of the lead. */
    async opportunitiesOpened(from: Date, to: Date, f: ReportFilter): Promise<OwnerCountRow[]> {
        const rows = await this.db.$queryRaw<Array<{ owner_id: bigint | null; n: bigint }>>(Prisma.sql`
            SELECT l.owner_id, COUNT(*) AS n
            FROM opportunities o JOIN leads l ON l.id = o.lead_id JOIN lead_sources s ON s.id = l.first_source_id
            WHERE o.opened_at >= ${from} AND o.opened_at < ${to} AND ${this.scope(f)}
            GROUP BY l.owner_id`);
        return rows.map((r) => ({ ownerId: r.owner_id, count: num(r.n) }));
    }

    /** Opportunities closed as won in [from, to), per owner of the lead. */
    async opportunitiesWon(from: Date, to: Date, f: ReportFilter): Promise<OwnerCountRow[]> {
        const rows = await this.db.$queryRaw<Array<{ owner_id: bigint | null; n: bigint }>>(Prisma.sql`
            SELECT l.owner_id, COUNT(*) AS n
            FROM opportunities o JOIN leads l ON l.id = o.lead_id JOIN lead_sources s ON s.id = l.first_source_id
            WHERE o.status = 'WON' AND o.closed_at >= ${from} AND o.closed_at < ${to} AND ${this.scope(f)}
            GROUP BY l.owner_id`);
        return rows.map((r) => ({ ownerId: r.owner_id, count: num(r.n) }));
    }

    /**
     * Money from the deals won in [from, to), per owner of the lead and payment mode: the fees agreed, what has been
     * collected, and how many wins have no payment recorded yet (mode null).
     */
    async revenue(from: Date, to: Date, f: ReportFilter): Promise<Array<{ ownerId: bigint | null; mode: string | null; deals: number; fee: number; collected: number }>> {
        const rows = await this.db.$queryRaw<Array<{ owner_id: bigint | null; mode: string | null; n: bigint; fee: bigint | number | null; collected: bigint | number | null }>>(Prisma.sql`
            SELECT l.owner_id, e.payment_mode AS mode, COUNT(*) AS n,
                   CAST(COALESCE(SUM(e.fee_amount), 0) AS SIGNED) AS fee, CAST(COALESCE(SUM(e.amount_collected), 0) AS SIGNED) AS collected
            FROM opportunities o
            JOIN leads l ON l.id = o.lead_id
            JOIN lead_sources s ON s.id = l.first_source_id
            LEFT JOIN enrolments e ON e.opportunity_id = o.id
            WHERE o.status = 'WON' AND o.closed_at >= ${from} AND o.closed_at < ${to} AND ${this.scope(f)}
            GROUP BY l.owner_id, e.payment_mode`);
        return rows.map((r) => ({ ownerId: r.owner_id, mode: r.mode, deals: num(r.n), fee: num(r.fee), collected: num(r.collected) }));
    }

    /**
     * For the opportunities opened in [from, to): how many got as far as each stage, by the furthest stage each one
     * ever reached (counting where it stands now, in case its history is thin). Index 0 is the first stage.
     */
    async furthestStages(from: Date, to: Date, f: ReportFilter): Promise<number[]> {
        const order = Prisma.join(FUNNEL_STAGES.map((s) => Prisma.sql`${s}`));
        const rows = await this.db.$queryRaw<Array<{ furthest: bigint; n: bigint }>>(Prisma.sql`
            SELECT x.furthest, COUNT(*) AS n FROM (
                SELECT GREATEST(FIELD(o.stage, ${order}), COALESCE(MAX(FIELD(c.to_stage, ${order})), 0)) AS furthest
                FROM opportunities o
                JOIN leads l ON l.id = o.lead_id
                JOIN lead_sources s ON s.id = l.first_source_id
                LEFT JOIN opportunity_stage_changes c ON c.opportunity_id = o.id
                WHERE o.opened_at >= ${from} AND o.opened_at < ${to} AND ${this.scope(f)}
                GROUP BY o.id, o.stage
            ) x GROUP BY x.furthest`);
        const counts = FUNNEL_STAGES.map(() => 0);
        for (const r of rows) {
            const index = num(r.furthest) - 1; // FIELD is 1-based
            if (index >= 0 && index < counts.length) counts[index] = num(r.n);
        }
        return counts;
    }

    /** Opportunities closed as lost in [from, to), by the reason given. */
    async lostReasons(from: Date, to: Date, f: ReportFilter): Promise<Array<{ reason: string; count: number }>> {
        const rows = await this.db.$queryRaw<Array<{ reason: string | null; n: bigint }>>(Prisma.sql`
            SELECT r.name AS reason, COUNT(*) AS n
            FROM opportunities o
            JOIN leads l ON l.id = o.lead_id
            JOIN lead_sources s ON s.id = l.first_source_id
            LEFT JOIN lost_reasons r ON r.id = o.lost_reason_id
            WHERE o.status = 'LOST' AND o.closed_at >= ${from} AND o.closed_at < ${to} AND ${this.scope(f)}
            GROUP BY r.name
            ORDER BY n DESC, r.name ASC`);
        return rows.map((r) => ({ reason: r.reason ?? 'No reason given', count: num(r.n) }));
    }

    /** Leads captured per India day and source group in [from, to). */
    async leadsPerDayAndGroup(from: Date, to: Date, f: ReportFilter): Promise<Array<{ day: string; group: SourceGroupName; count: number }>> {
        const rows = await this.db.$queryRaw<Array<{ day: string; grp: SourceGroupName; n: bigint }>>(Prisma.sql`
            SELECT DATE_FORMAT(DATE_ADD(l.captured_at, INTERVAL 330 MINUTE), '%Y-%m-%d') AS day, s.\`group\` AS grp, COUNT(*) AS n
            FROM leads l JOIN lead_sources s ON s.id = l.first_source_id
            WHERE l.captured_at >= ${from} AND l.captured_at < ${to} AND ${this.scope(f)}
            GROUP BY day, grp`);
        return rows.map((r) => ({ day: r.day, group: r.grp, count: num(r.n) }));
    }

    /**
     * Calls logged in [from, to), per person who made them, on leads from the filtered source group. A BDA's own view
     * counts the calls they made, whoever owns the lead, so their connect rate matches what a manager sees for them.
     */
    async callsByUser(from: Date, to: Date, f: ReportFilter): Promise<CallCountRow[]> {
        const rows = await this.db.$queryRaw<Array<{ user_id: bigint; total: bigint; connected: bigint | null }>>(Prisma.sql`
            SELECT a.user_id, COUNT(*) AS total, CAST(SUM(a.connected = 1) AS UNSIGNED) AS connected
            FROM activities a JOIN leads l ON l.id = a.lead_id JOIN lead_sources s ON s.id = l.first_source_id
            WHERE a.kind = 'CALL' AND a.occurred_at >= ${from} AND a.occurred_at < ${to}
              AND ${this.scope({ ownerId: null, group: f.group })}
              ${f.ownerId === null ? Prisma.empty : Prisma.sql`AND a.user_id = ${f.ownerId}`}
            GROUP BY a.user_id`);
        return rows.map((r) => ({ userId: r.user_id, total: num(r.total), connected: num(r.connected) }));
    }

    /** The source groups the leads in scope come from, whatever group is filtered, for the source picker. */
    async sourceGroupsInScope(ownerId: bigint | null): Promise<SourceGroupName[]> {
        const rows = await this.db.$queryRaw<Array<{ grp: SourceGroupName }>>(Prisma.sql`
            SELECT DISTINCT s.\`group\` AS grp
            FROM leads l JOIN lead_sources s ON s.id = l.first_source_id
            WHERE l.merged_into_id IS NULL AND l.anonymised_at IS NULL
              ${ownerId === null ? Prisma.empty : Prisma.sql`AND l.owner_id = ${ownerId}`}`);
        return rows.map((r) => r.grp);
    }

    /**
     * The people in the BDA table: every active BDA (so one with no leads still has a row), plus a sales manager who
     * owns leads or makes calls. Admins, ops and closers never get a row, even when they own a lead or log a call.
     */
    async staffForTable(ids: bigint[], onlyId: bigint | null): Promise<StaffRow[]> {
        const rows = await this.db.staffUser.findMany({
            where:
                onlyId !== null
                    ? { id: onlyId }
                    : {
                          OR: [
                              { role: 'BDA', isActive: true },
                              ...(ids.length > 0 ? [{ id: { in: ids }, role: { in: ['BDA' as const, 'SALES_MANAGER' as const] } }] : []),
                          ],
                      },
            select: { id: true, publicId: true, name: true },
            orderBy: { name: 'asc' },
        });
        return rows;
    }

    /** How long each lead captured in [from, to) waited for its first touch. One light row per lead. */
    async firstTouches(from: Date, to: Date, f: ReportFilter): Promise<FirstTouchRow[]> {
        const rows = await this.db.$queryRaw<Array<{ grp: SourceGroupName; secs: bigint | number | null; age: bigint | number }>>(Prisma.sql`
            SELECT s.\`group\` AS grp,
                   CASE WHEN l.first_touch_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(SECOND, l.captured_at, l.first_touch_at) END AS secs,
                   TIMESTAMPDIFF(SECOND, l.captured_at, NOW(3)) AS age
            FROM leads l JOIN lead_sources s ON s.id = l.first_source_id
            WHERE l.captured_at >= ${from} AND l.captured_at < ${to} AND ${this.scope(f)}`);
        return rows.map((r) => ({ group: r.grp, seconds: r.secs === null ? null : Math.max(0, num(r.secs)), ageSeconds: num(r.age) }));
    }

    /** Open opportunities per stage: how many, how long they have sat there, and how many sat longer than `staleDays`. */
    async stageAging(f: ReportFilter, staleDays: number): Promise<StageAgeRow[]> {
        const rows = await this.db.$queryRaw<Array<{ stage: string; n: bigint; avg_days: number | null; max_days: number | null; stale: bigint | null }>>(Prisma.sql`
            SELECT o.stage, COUNT(*) AS n,
                   AVG(TIMESTAMPDIFF(MINUTE, o.stage_changed_at, NOW(3)) / 1440) AS avg_days,
                   MAX(TIMESTAMPDIFF(MINUTE, o.stage_changed_at, NOW(3)) / 1440) AS max_days,
                   CAST(SUM(TIMESTAMPDIFF(MINUTE, o.stage_changed_at, NOW(3)) >= ${staleDays * 1440}) AS UNSIGNED) AS stale
            FROM opportunities o JOIN leads l ON l.id = o.lead_id JOIN lead_sources s ON s.id = l.first_source_id
            WHERE o.status = 'OPEN' AND ${this.scope(f)}
            GROUP BY o.stage`);
        return rows.map((r) => ({ stage: r.stage, open: num(r.n), avgDays: Number(r.avg_days ?? 0), maxDays: Number(r.max_days ?? 0), stale: num(r.stale) }));
    }

    /** The open opportunities that have waited longest in their stage. */
    async longestStuck(f: ReportFilter, take: number): Promise<StuckRow[]> {
        const rows = await this.db.$queryRaw<Array<{ public_id: string; name: string; stage: string; days: number; owner: string | null }>>(Prisma.sql`
            SELECT l.public_id, l.full_name AS name, o.stage,
                   TIMESTAMPDIFF(MINUTE, o.stage_changed_at, NOW(3)) / 1440 AS days, u.name AS owner
            FROM opportunities o JOIN leads l ON l.id = o.lead_id JOIN lead_sources s ON s.id = l.first_source_id
            LEFT JOIN staff_users u ON u.id = l.owner_id
            WHERE o.status = 'OPEN' AND ${this.scope(f)}
            ORDER BY o.stage_changed_at ASC
            LIMIT ${take}`);
        return rows.map((r) => ({ leadId: r.public_id, name: r.name, stage: r.stage, days: Number(r.days), ownerName: r.owner }));
    }

    /** Leads handed to each person in [from, to), with how many were hot and how many came in deep through the VSL. */
    async assignedTo(from: Date, to: Date, group: SourceGroupName | null): Promise<AssignedRow[]> {
        const rows = await this.db.$queryRaw<Array<{ user_id: bigint; n: bigint; hot: bigint | null; deep: bigint | null }>>(Prisma.sql`
            SELECT a.to_user_id AS user_id, COUNT(*) AS n,
                   CAST(SUM(a.temperature = 'HOT') AS UNSIGNED) AS hot,
                   CAST(SUM(a.vsl_depth <> 'NONE') AS UNSIGNED) AS deep
            FROM lead_assignments a JOIN lead_sources s ON s.id = a.source_id
            WHERE a.to_user_id IS NOT NULL AND a.created_at >= ${from} AND a.created_at < ${to}
              ${group === null ? Prisma.empty : Prisma.sql`AND s.\`group\` = ${group}`}
            GROUP BY a.to_user_id`);
        return rows.map((r) => ({ userId: r.user_id, assigned: num(r.n), hot: num(r.hot), deepVsl: num(r.deep) }));
    }

    /** Active BDAs: the people a fairness report compares (one with no leads still counts as having none). */
    async activeBdas(): Promise<StaffRow[]> {
        return this.db.staffUser.findMany({ where: { role: 'BDA', isActive: true }, select: { id: true, publicId: true, name: true }, orderBy: { name: 'asc' } });
    }
}
