import { type ColumnMapping } from './import-fields.js';
import {
    evaluateRow,
    parseEmail,
    parsePhone,
    parseUserType,
    resolveMapping,
} from './row-normalizer.js';

describe('parsePhone', () => {
    it.each([
        ['9876543210', '+919876543210', '9876543210'],
        ['98765 43210', '+919876543210', '9876543210'],
        ['98765-43210', '+919876543210', '9876543210'],
        ['+91 98765 43210', '+919876543210', '9876543210'],
        ['+91-9876543210', '+919876543210', '9876543210'],
        ['919876543210', '+919876543210', '9876543210'],
        ['09876543210', '+919876543210', '9876543210'],
        ['0091 9876543210', '+919876543210', '9876543210'],
        ['(+91) 98765 43210', '+919876543210', '9876543210'],
        ['p:+919876543210', '+919876543210', '9876543210'],
        ['tel:9876543210', '+919876543210', '9876543210'],
        ['9876543210.0', '+919876543210', '9876543210'],
        ['+44 7911 123456', '+447911123456', '7911123456'],
        ['+1 (415) 555-2671', '+14155552671', '4155552671'],
    ])('reads %j', (raw, e164, last10) => {
        expect(parsePhone(raw)).toEqual({ ok: true, e164, last10 });
    });

    it.each([
        '', ' ', 'abc', '12345', '5876543210', '98765432', '98765432101234', '9999999999',
        '0000000000', '+91 12345 67890', 'call me', '98765x43210', '+0123456789',
    ])('rejects %j', (raw) => {
        expect(parsePhone(raw).ok).toBe(false);
    });

    it('explains Excel scientific notation', () => {
        const result = parsePhone('9.87654E+11');
        expect(result.ok).toBe(false);
        expect(!result.ok && result.reason).toMatch(/scientific notation/);
    });

    it('gives the same key for every way of writing the same number', () => {
        const a = parsePhone('+91 98765 43210');
        const b = parsePhone('09876543210');
        const c = parsePhone('98765-43210');
        expect([a, b, c].map((r) => r.ok && r.last10)).toEqual(['9876543210', '9876543210', '9876543210']);
    });
});

describe('parseEmail', () => {
    it('lowercases and trims', () => {
        expect(parseEmail('  Ravi.Kumar@Example.COM ')).toEqual({ ok: true, email: 'ravi.kumar@example.com' });
        expect(parseEmail('mailto:a@b.co')).toEqual({ ok: true, email: 'a@b.co' });
    });

    it.each([
        'plainaddress', 'a@b', '@b.com', 'a@@b.com', 'a b@c.com', 'a@b.com, c@d.com',
        'a@b.com;c@d.com', 'a..b@c.com', 'a@b..com', '<a@b.com>', `${'a'.repeat(150)}@x.com`,
    ])('rejects %j', (raw) => {
        expect(parseEmail(raw).ok).toBe(false);
    });
});

describe('parseUserType', () => {
    it.each([
        ['Working Professional', 'WORKING_PROFESSIONAL'],
        ['employed', 'WORKING_PROFESSIONAL'],
        ['Student', 'STUDENT'],
        ['Engineering student', 'STUDENT'],
        ['working professional (recent graduate)', 'WORKING_PROFESSIONAL'],
        ['unknown', null],
    ])('%j is %j', (raw, expected) => {
        expect(parseUserType(raw)).toBe(expected);
    });
});

describe('evaluateRow', () => {
    const columns: ColumnMapping[] = [
        { index: 0, target: 'name' },
        { index: 1, target: 'email' },
        { index: 2, target: 'phone' },
        { index: 3, target: 'company' },
        { index: 4, target: 'ctc' },
        { index: 5, target: 'gradYear' },
        { index: 6, target: 'domain' },
        { index: 7, target: 'leadScore' },
        { index: 8, target: 'userType' },
        { index: 9, target: 'custom', label: 'Current city' },
        { index: 10, target: 'sourceDetail' },
    ];
    const mapping = resolveMapping(columns);
    const now = new Date('2026-11-04T00:00:00Z');
    const row = (over: Partial<Record<number, string>> = {}): string[] => {
        const cells = ['  Ravi   Kumar ', 'Ravi@X.com', '98765 43210', 'Acme', '10-15 LPA', '2019', 'Backend', '25', 'Working professional', 'Pune', 'naukri'];
        for (const [i, v] of Object.entries(over)) cells[Number(i)] = v ?? '';
        return cells;
    };

    it('cleans a full row', () => {
        const result = evaluateRow(row(), mapping, now);
        expect(result).toEqual({
            ok: true,
            warnings: [],
            lead: {
                fullName: 'Ravi Kumar',
                email: 'ravi@x.com',
                phoneE164: '+919876543210',
                phoneLast10: '9876543210',
                currentCompany: 'Acme',
                currentCtc: '10-15 LPA',
                graduationYear: '2019',
                domain: 'Backend',
                userType: 'WORKING_PROFESSIONAL',
                leadScore: 25,
                sourceDetail: 'naukri',
                custom: { current_city: 'Pune' },
            },
        });
    });

    it('joins first and last name', () => {
        const split = resolveMapping([
            { index: 0, target: 'firstName' },
            { index: 1, target: 'lastName' },
            { index: 2, target: 'email' },
        ]);
        const result = evaluateRow(['Asha', 'Rao', 'a@b.co'], split, now);
        expect(result.ok && result.lead.fullName).toBe('Asha Rao');
        const onlyFirst = evaluateRow(['Asha', '', 'a@b.co'], split, now);
        expect(onlyFirst.ok && onlyFirst.lead.fullName).toBe('Asha');
    });

    it('needs a name', () => {
        expect(evaluateRow(row({ 0: '  ' }), mapping, now)).toEqual({ ok: false, error: 'Name is missing.' });
        expect(evaluateRow(row({ 0: 'x'.repeat(151) }), mapping, now)).toEqual({ ok: false, error: 'Name is too long.' });
    });

    it('needs an email or a phone', () => {
        expect(evaluateRow(row({ 1: '', 2: '' }), mapping, now)).toEqual({
            ok: false,
            error: 'The row has no email or phone.',
        });
    });

    it('rejects a row whose only identity is invalid, naming what is wrong', () => {
        expect(evaluateRow(row({ 1: 'nope', 2: '' }), mapping, now)).toEqual({ ok: false, error: 'Email is not valid.' });
        expect(evaluateRow(row({ 1: '', 2: '12345' }), mapping, now)).toEqual({
            ok: false,
            error: 'Phone is not a valid Indian mobile number.',
        });
        expect(evaluateRow(row({ 1: 'nope', 2: '12345' }), mapping, now)).toEqual({
            ok: false,
            error: 'Neither the email nor the phone number is valid.',
        });
    });

    it('keeps the lead when one of two identities is bad, and says what was dropped', () => {
        const badEmail = evaluateRow(row({ 1: 'nope' }), mapping, now);
        expect(badEmail.ok && badEmail.lead.email).toBeNull();
        expect(badEmail.ok && badEmail.lead.phoneLast10).toBe('9876543210');
        expect(badEmail.ok && badEmail.warnings).toEqual(['Email is not valid, so it was left out.']);

        const badPhone = evaluateRow(row({ 2: '12345' }), mapping, now);
        expect(badPhone.ok && badPhone.lead.phoneE164).toBeNull();
        expect(badPhone.ok && badPhone.warnings).toEqual([
            'Phone is not a valid Indian mobile number, so it was left out.',
        ]);
    });

    it('imports the lead and drops a bad optional value with a warning', () => {
        const result = evaluateRow(
            row({ 5: '20222', 7: 'high', 8: 'astronaut', 4: 'x'.repeat(101), 9: 'y'.repeat(501) }),
            mapping,
            now,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.lead.graduationYear).toBeNull();
        expect(result.lead.leadScore).toBe(0);
        expect(result.lead.userType).toBe('UNKNOWN');
        expect(result.lead.currentCtc).toBeNull();
        expect(result.lead.custom).toEqual({});
        expect(result.warnings).toHaveLength(5);
    });

    it.each([
        ['1969', null], ['1970', '1970'], ['2034', '2034'], ['2035', null], ['2019.0', '2019'], ['19', null],
    ])('graduation year %j becomes %j', (year, expected) => {
        const result = evaluateRow(row({ 5: year }), mapping, now);
        expect(result.ok && result.lead.graduationYear).toBe(expected);
    });

    it.each([
        ['0', 0], ['10000', 10000], ['10001', 0], ['-5', 0], ['12.0', 12], ['+7', 7], ['3.5', 0], ['', 0],
    ])('lead score %j becomes %j', (score, expected) => {
        const result = evaluateRow(row({ 7: score }), mapping, now);
        expect(result.ok && result.lead.leadScore).toBe(expected);
    });

    it('ignores unmapped columns and short rows', () => {
        const small = resolveMapping([
            { index: 0, target: 'name' },
            { index: 1, target: 'email' },
        ]);
        const result = evaluateRow(['Asha', 'a@b.co'], small, now);
        expect(result.ok && result.lead.currentCompany).toBeNull();
        expect(result.ok && result.lead.leadScore).toBe(0);
    });
});
