import { z } from 'zod';
import type { LeadSourceRule } from '@modules/leads';

/** A long free-text value from a sender is cut to fit rather than refused: it must never lose a lead. */
const text = (max: number) => z.string().transform((value) => value.trim().slice(0, max));
const optionalText = (max: number) => text(max).nullish();

const submissionId = z.string('Send the submissionId').trim().min(8).max(64);
const bookingId = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(64));

/** Who the person is. Every VSL event carries it, so events can arrive in any order and still find or make the lead. */
const person = {
    fullName: z.string('Send fullName').trim().min(1).max(150),
    email: z.string('Send email').trim().toLowerCase().max(150).pipe(z.email()),
    phone: optionalText(30),
};

const campaign = {
    source: optionalText(100),
    landingPage: optionalText(500),
    utmSource: optionalText(100),
    utmMedium: optionalText(100),
    utmCampaign: optionalText(150),
    utmContent: optionalText(150),
    utmTerm: optionalText(150),
};

/** Step 1: the person gave their details. */
export const vslDetailsSchema = z.object({
    submissionId,
    formSlug: z.string().trim().min(1).max(100),
    ...person,
    ...campaign,
});

/** Step 2: the person filled the qualification form. */
export const vslFormSchema = z.object({
    submissionId,
    formSlug: z.string().trim().min(1).max(100),
    ...person,
    ...campaign,
    score: z.number().int().min(0).max(100).nullish(),
    temperature: z
        .string()
        .transform((v) => v.trim().toUpperCase())
        .pipe(z.enum(['HOT', 'WARM', 'COLD']))
        .nullish(),
    /** Labels, not option ids: what a person reading the lead page needs. */
    answers: z
        .array(z.object({ key: z.string().trim().min(1).max(100), question: text(500), answer: text(1000) }))
        .max(80),
    submittedAt: z.coerce.date(),
});

/** Step 3: the person booked a counselling call. */
export const vslBookedSchema = z.object({
    bookingId,
    submissionId,
    formSlug: z.string().trim().max(100).nullish(),
    ...person,
    slotStartAt: z.coerce.date(),
    slotLabel: text(100),
});

/** The call took place (the VSL team marked it done). */
export const vslCompletedSchema = z.object({
    bookingId,
    submissionId: submissionId.nullish(),
    completedAt: z.coerce.date(),
});

export type VslDetails = z.infer<typeof vslDetailsSchema>;
export type VslForm = z.infer<typeof vslFormSchema>;
export type VslBooked = z.infer<typeof vslBookedSchema>;
export type VslCompleted = z.infer<typeof vslCompletedSchema>;

export interface SourceContext {
    system: string;
    formSlug?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
}

const norm = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/**
 * Picks the lead source for a VSL event from the sources' rules, tried in the order the CRM lists
 * them. A rule is a set of conditions that must all hold, each naming a field of the event
 * (system, formSlug, utmSource, ...) and one value or a list of values. A source with no rule
 * never matches here. Nothing matching means the person came in on their own: Organic.
 */
export function matchSource(sources: LeadSourceRule[], context: SourceContext): LeadSourceRule | undefined {
    const values = context as unknown as Record<string, unknown>;
    for (const source of sources) {
        const rule = source.matchRule;
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        const conditions = Object.entries(rule as Record<string, unknown>);
        if (conditions.length === 0) continue;
        const holds = conditions.every(([field, wanted]) => {
            const actual = norm(values[field]);
            if (!actual) return false;
            return Array.isArray(wanted) ? wanted.some((w) => norm(w) === actual) : norm(wanted) === actual;
        });
        if (holds) return source;
    }
    return (
        sources.find((s) => s.name === 'Organic') ??
        sources.find((s) => s.group === 'ORGANIC') ??
        sources.find((s) => s.group === 'VSL')
    );
}

/** The form answers that fill gaps in what the CRM knows about a person. */
export function profileFromAnswers(answers: VslForm['answers']): { currentCompany: string | null; currentCtc: string | null } {
    const byKey = new Map(answers.map((a) => [a.key, a.answer]));
    const clip = (v: string | undefined, max: number) => (v && v.trim() ? v.trim().slice(0, max) : null);
    return { currentCompany: clip(byKey.get('company'), 255), currentCtc: clip(byKey.get('currentCtc'), 100) };
}
