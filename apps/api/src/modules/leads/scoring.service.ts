import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { type NewTimelineEvent, TimelineService } from '@modules/timeline';
import { LeadsRepository } from './leads.repository.js';
import { awardsFor, ScoreReason } from './score-rules.js';

/** How many timeline events a recalculation reads at a time. */
const BATCH = 500;
/**
 * Bump when the rules change in a way old leads should catch up on: the next start runs the catch-up once.
 * Admins can also run it from a lead's Score history.
 */
const CATCH_UP_KEY = 'scoring.caught-up.v2';

/** Points that arrive with the VSL, before anyone has called: held until the team has tried the lead once. */
const FORM_SCORE_REASON = 'VSL_FORM_SCORE';
const HELD_REASONS: ReadonlySet<string> = new Set([ScoreReason.VslDetails, ScoreReason.SlotBooked]);
/** The timeline events that can carry held points. */
const HELD_EVENT_TYPES = ['LEAD_CREATED', 'TOUCHPOINT_ADDED', 'SLOT_BOOKED'];
/** Logged activities that count as the team trying the lead (a note does not). */
const OUTREACH_KINDS: ReadonlySet<string> = new Set(['CALL', 'WHATSAPP', 'EMAIL']);

/**
 * Keeps lead scores up to date on their own. It listens to the timeline: every event written for a lead is run
 * through the score rules (score-rules.ts) and any points are added to the lead's ledger. A failure here never
 * stops the change that wrote the event; it is logged and a recalculation catches it up.
 */
@Injectable()
export class ScoringService implements OnModuleInit, OnApplicationBootstrap {
    private readonly logger = new Logger(ScoringService.name);

    constructor(
        private readonly repository: LeadsRepository,
        private readonly timeline: TimelineService,
    ) {}

    onModuleInit(): void {
        this.timeline.subscribe((events) => this.scoreEvents(events));
    }

    /**
     * The first time the app starts with these rules, scores every existing lead from its history, in the
     * background, so nobody has to remember to. Only one process (API or worker) does it.
     */
    onApplicationBootstrap(): void {
        // The test suites build and wipe their own data; a background catch-up would race them.
        if (process.env.VITEST) return;
        void this.catchUpOnce();
    }

    private async catchUpOnce(): Promise<void> {
        try {
            if (!(await this.repository.claimOnce(CATCH_UP_KEY))) return;
            const started = Date.now();
            // Leads nobody has tried yet lose their VSL points until the first attempt (v2 of the rules).
            const held = await this.repository.holdVslPoints([...HELD_REASONS, FORM_SCORE_REASON]);
            if (held > 0) this.logger.log(`VSL points held back until the first attempt: ${held} leads`);
            const result = await this.recalculate();
            this.logger.log(`Lead scores caught up: ${result.leads} leads, ${result.points} points, from ${result.events} events in ${Math.round((Date.now() - started) / 1000)}s`);
        } catch (error) {
            this.logger.error(`The lead score catch-up stopped: ${error instanceof Error ? error.message : String(error)}. An admin can run it from a lead's Score history.`);
        }
    }

    async scoreEvents(events: NewTimelineEvent[], now = new Date()): Promise<void> {
        for (const event of events) {
            try {
                await this.scoreOne(event.leadId, event.type, (event.data ?? null) as Record<string, unknown> | null, now, true);
            } catch (error) {
                this.logger.error(`Could not score ${event.type} for lead ${event.leadId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /** Returns the points added. */
    private async scoreOne(leadId: bigint, type: string, data: Record<string, unknown> | null, now: Date, live = false): Promise<number> {
        let connected: boolean | null = typeof data?.connected === 'boolean' ? data.connected : null;
        if (type === 'ACTIVITY_LOGGED' && data?.kind === 'CALL' && connected === null && typeof data.activity === 'string' && /^\d+$/.test(data.activity)) {
            connected = await this.repository.activityConnected(BigInt(data.activity));
        }
        let added = 0;
        let tried: boolean | null = null;
        for (const award of awardsFor({ type, data }, connected)) {
            if (HELD_REASONS.has(award.reason)) {
                tried ??= await this.repository.hasOutreach(leadId);
                if (!tried) continue;
            }
            added += await this.repository.awardScoreOnce({ leadId, ...award, now });
        }
        // The team has just tried this lead: whatever the VSL gave it while it waited now counts.
        if (live && type === 'ACTIVITY_LOGGED' && typeof data?.kind === 'string' && OUTREACH_KINDS.has(data.kind)) {
            added += await this.releaseHeld(leadId, now);
        }
        return added;
    }

    /** Adds the VSL points a lead earned before anyone tried it: its details, a booked slot and the newest form score. Safe to repeat. */
    private async releaseHeld(leadId: bigint, now: Date): Promise<number> {
        let added = 0;
        for (const event of await this.repository.timelineEventsOf(leadId, HELD_EVENT_TYPES)) {
            for (const award of awardsFor(event)) {
                if (HELD_REASONS.has(award.reason)) added += await this.repository.awardScoreOnce({ leadId, ...award, now });
            }
        }
        const form = await this.repository.newestScoredFormOf(leadId);
        if (form) added += await this.repository.applyFormScore(leadId, form.submissionRef, form.score, now);
        return added;
    }

    /**
     * Goes through every lead's history again and adds whatever points are missing: for leads that came in before
     * scoring existed, or after a rule changed. Safe to run any number of times; nothing is counted twice.
     */
    async recalculate(now = new Date()): Promise<{ events: number; leads: number; points: number }> {
        let after = 0n;
        let events = 0;
        let points = 0;
        const touched = new Set<bigint>();
        for (;;) {
            const batch = await this.repository.timelineEventsAfter(after, BATCH);
            if (batch.length === 0) break;
            for (const e of batch) {
                const added = await this.scoreOne(e.leadId, e.type, e.data, now);
                if (added !== 0) {
                    points += added;
                    touched.add(e.leadId);
                }
            }
            events += batch.length;
            after = batch[batch.length - 1]!.id;
        }
        // The VSL form's score, for leads whose newest form was never counted.
        for (const form of await this.repository.newestScoredForms()) {
            if (!(await this.repository.hasOutreach(form.leadId))) continue;
            const added = await this.repository.applyFormScore(form.leadId, form.submissionRef, form.score, now);
            if (added !== 0) {
                points += added;
                touched.add(form.leadId);
            }
        }
        return { events, leads: touched.size, points };
    }
}
