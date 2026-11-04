import { isWorkingProfessional, istDayKey, istDayLabel, normalisePhone, workrSignupSchema } from './workr-signup.js';

describe('isWorkingProfessional', () => {
    it('accepts the WorkR value in any case and rejects everything else', () => {
        expect(isWorkingProfessional('Working Professional')).toBe(true);
        expect(isWorkingProfessional('  working professional ')).toBe(true);
        expect(isWorkingProfessional('Student')).toBe(false);
        expect(isWorkingProfessional('')).toBe(false);
        expect(isWorkingProfessional(null)).toBe(false);
        expect(isWorkingProfessional(undefined)).toBe(false);
    });
});

describe('normalisePhone', () => {
    it.each([
        ['9876543210', '9876543210'],
        ['+91 98765 43210', '9876543210'],
        ['919876543210', '9876543210'],
        ['09876543210', '9876543210'],
    ])('reads %s', (raw, last10) => {
        expect(normalisePhone(raw)).toEqual({ phoneE164: `+91${last10}`, phoneLast10: last10 });
    });

    it.each(['', '12345', '5876543210', '98765432101234', null, undefined])('rejects %s', (raw) => {
        expect(normalisePhone(raw as string | null | undefined)).toBeNull();
    });
});

describe('Indian day', () => {
    it('puts 11 pm UTC on the next Indian day', () => {
        // 2026-11-04 20:00 UTC is 2026-11-05 01:30 in India
        const at = new Date('2026-11-04T20:00:00Z');
        expect(istDayKey(at)).toBe('2026-11-05');
        expect(istDayLabel(at)).toBe('5 Nov 2026');
    });
});

describe('workrSignupSchema', () => {
    const base = { userId: 12, fullName: ' Asha Rao ', email: ' ASHA@Example.com ', details: 'Working Professional' };

    it('trims and lower-cases', () => {
        const parsed = workrSignupSchema.parse(base);
        expect(parsed.fullName).toBe('Asha Rao');
        expect(parsed.email).toBe('asha@example.com');
    });

    it('rejects a bad email and a missing user id', () => {
        expect(workrSignupSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
        expect(workrSignupSchema.safeParse({ ...base, userId: undefined }).success).toBe(false);
    });
});
