import type { LeadSourceRule } from '@modules/leads';
import { depthWeight, priorityRankOf } from '../leads/vsl-priority.js';
import { matchSource, profileFromAnswers, vslBookedSchema, vslCompletedSchema, vslDetailsSchema, vslFormSchema } from './vsl-events.js';

const src = (id: number, name: string, group: string, matchRule: unknown): LeadSourceRule => ({ id, name, group, matchRule });
const SOURCES = [
    src(1, 'WorkR', 'WORKR', { system: 'WORKR' }),
    src(2, 'Meta ads', 'META', { system: 'VSL_FORM', utmSource: ['facebook', 'fb', 'ig'] }),
    src(3, 'VSL job-switch', 'VSL', { system: 'VSL_FORM', formSlug: 'job-switch' }),
    src(4, 'Organic', 'ORGANIC', null),
    src(5, 'CSV import', 'IMPORT', null),
];

describe('matchSource', () => {
    it('uses the first rule that holds, in the order given', () => {
        expect(matchSource(SOURCES, { system: 'VSL_FORM', formSlug: 'job-switch', utmSource: 'facebook' })?.name).toBe('Meta ads');
        expect(matchSource(SOURCES, { system: 'VSL_FORM', formSlug: 'job-switch', utmSource: 'google' })?.name).toBe('VSL job-switch');
    });
    it('compares without caring about case or spaces, and accepts a list of values', () => {
        expect(matchSource(SOURCES, { system: 'vsl_form', utmSource: ' FB ' })?.name).toBe('Meta ads');
    });
    it('never matches a rule for another system', () => {
        expect(matchSource(SOURCES, { system: 'VSL_FORM', formSlug: 'ai-fear' })?.name).toBe('Organic');
    });
    it('treats a missing field as not matching', () => {
        expect(matchSource([src(2, 'Meta ads', 'META', { system: 'VSL_FORM', utmSource: 'facebook' })], { system: 'VSL_FORM' })).toBeUndefined();
    });
    it('falls back to a VSL source when there is no Organic, and to nothing when there is neither', () => {
        expect(matchSource([src(3, 'VSL x', 'VSL', { system: 'WORKR' })], { system: 'VSL_FORM' })?.name).toBe('VSL x');
        expect(matchSource([src(5, 'CSV import', 'IMPORT', null)], { system: 'VSL_FORM' })).toBeUndefined();
    });
    it('ignores a rule that is not an object or is empty', () => {
        expect(matchSource([src(9, 'Odd', 'OTHER', 'x'), src(10, 'Empty', 'OTHER', {}), src(4, 'Organic', 'ORGANIC', null)], { system: 'VSL_FORM' })?.name).toBe('Organic');
    });
});

describe('priorityRankOf', () => {
    it('ranks a booked call above a filled form above bare details', () => {
        expect(priorityRankOf('BOOKED', null, null)).toBeGreaterThan(priorityRankOf('FORM', 'HOT', 100));
        expect(priorityRankOf('FORM', 'COLD', 0)).toBeGreaterThan(priorityRankOf('DETAILS', null, null));
    });
    it('orders by temperature, then by score, within one depth', () => {
        expect(priorityRankOf('FORM', 'HOT', 10)).toBeGreaterThan(priorityRankOf('FORM', 'WARM', 90));
        expect(priorityRankOf('FORM', 'WARM', 80)).toBeGreaterThan(priorityRankOf('FORM', 'WARM', 60));
    });
    it('keeps a score outside 0 to 100 from spilling into the next tier', () => {
        expect(priorityRankOf('FORM', 'COLD', 5000)).toBeLessThan(priorityRankOf('FORM', 'WARM', 0));
        expect(priorityRankOf('FORM', 'COLD', -4)).toBe(priorityRankOf('FORM', 'COLD', 0));
    });
    it('knows which depth is further', () => {
        expect(depthWeight('BOOKED')).toBeGreaterThan(depthWeight('FORM'));
        expect(depthWeight('NONE')).toBe(0);
    });
});

const person = { fullName: 'Asha Rao', email: 'ASHA@Example.com ', phone: '9876543210' };
describe('VSL event payloads', () => {
    it('accepts details, lowercases the email and cuts long free text', () => {
        const r = vslDetailsSchema.parse({ submissionId: '11111111-2222-3333-4444-555555555555', formSlug: 'job-switch', ...person, landingPage: 'x'.repeat(900), utmSource: 'facebook' });
        expect(r.email).toBe('asha@example.com');
        expect(r.landingPage).toHaveLength(500);
    });
    it('rejects a payload with no usable email, and says which field', () => {
        const r = vslDetailsSchema.safeParse({ submissionId: '11111111-2222-3333-4444-555555555555', formSlug: 'job-switch', fullName: 'A', email: 'nope' });
        expect(r.success).toBe(false);
        expect(r.error?.issues[0]?.path).toEqual(['email']);
    });
    it('reads a form with answers and an upper- or lower-case temperature', () => {
        const r = vslFormSchema.parse({
            submissionId: '11111111-2222-3333-4444-555555555555', formSlug: 'job-switch', ...person,
            score: 72, temperature: 'warm', submittedAt: '2026-11-05T05:00:00Z',
            answers: [{ key: 'company', question: 'Current Company', answer: 'TCS' }],
        });
        expect(r).toMatchObject({ score: 72, temperature: 'WARM' });
        expect(vslFormSchema.safeParse({ ...r, temperature: 'lukewarm', submittedAt: '2026-11-05T05:00:00Z' }).success).toBe(false);
        expect(vslFormSchema.safeParse({ ...r, score: 101, submittedAt: '2026-11-05T05:00:00Z' }).success).toBe(false);
    });
    it('accepts a numeric booking id and turns it into text', () => {
        const r = vslBookedSchema.parse({ bookingId: 42, submissionId: '11111111-2222-3333-4444-555555555555', ...person, slotStartAt: '2026-11-06T05:30:00Z', slotLabel: '6 Nov 2026, 11:00 AM' });
        expect(r.bookingId).toBe('42');
        expect(vslCompletedSchema.parse({ bookingId: '42', completedAt: '2026-11-06T06:00:00Z' }).bookingId).toBe('42');
    });
    it('pulls company and CTC out of the answers', () => {
        expect(profileFromAnswers([{ key: 'company', question: 'q', answer: ' TCS ' }, { key: 'currentCtc', question: 'q', answer: '10 - 15 LPA' }, { key: 'role', question: 'q', answer: 'Dev' }]))
            .toEqual({ currentCompany: 'TCS', currentCtc: '10 - 15 LPA' });
        expect(profileFromAnswers([])).toEqual({ currentCompany: null, currentCtc: null });
    });
});
