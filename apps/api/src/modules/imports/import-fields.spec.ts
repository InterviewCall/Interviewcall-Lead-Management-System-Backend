import {
    type ColumnMapping,
    customFieldKey,
    suggestMapping,
    validateMapping,
} from './import-fields.js';

describe('suggestMapping', () => {
    it('recognises common header spellings', () => {
        const mapping = suggestMapping([
            'Full Name',
            'Email Address',
            'Mobile Number',
            'Current Company',
            'CTC (LPA)',
            'Graduation Year',
            'Domain',
            'UTM Source',
        ]);
        expect(mapping.map((m) => m.target)).toEqual([
            'name', 'email', 'phone', 'company', 'ctc', 'gradYear', 'domain', 'sourceDetail',
        ]);
    });

    it('uses each field once and leaves repeats out', () => {
        const mapping = suggestMapping(['Email', 'Email ID', 'Phone']);
        expect(mapping.map((m) => m.target)).toEqual(['email', 'skip', 'phone']);
    });

    it('leaves unknown columns out instead of inventing fields', () => {
        const mapping = suggestMapping(['Name', 'Email', 'Unnamed: 7', 'Remarks']);
        expect(mapping.map((m) => m.target)).toEqual(['name', 'email', 'skip', 'skip']);
    });

    it('maps a column to an existing custom field by its label', () => {
        const mapping = suggestMapping(['Name', 'Email', 'Current City'], [
            { key: 'current_city', label: 'Current city' },
        ]);
        expect(mapping[2]).toEqual({ index: 2, target: 'custom', label: 'Current city' });
    });

    it('suggests first and last name only when there is no full-name column', () => {
        expect(suggestMapping(['First Name', 'Last Name', 'Email']).map((m) => m.target)).toEqual([
            'firstName', 'lastName', 'email',
        ]);
        expect(suggestMapping(['Name', 'First Name', 'Email']).map((m) => m.target)).toEqual([
            'name', 'skip', 'email',
        ]);
    });

    it('numbers columns by their position in the file', () => {
        expect(suggestMapping(['a', 'b']).map((m) => m.index)).toEqual([0, 1]);
    });
});

describe('customFieldKey', () => {
    it.each([
        ['Current City', 'current_city'],
        ['  Notes!! ', 'notes'],
        ['CTC (LPA)', 'ctc_lpa'],
        ['!!', ''],
    ])('%j becomes %j', (label, key) => {
        expect(customFieldKey(label)).toBe(key);
    });

    it('limits the key length', () => {
        expect(customFieldKey('a'.repeat(80))).toHaveLength(50);
    });
});

describe('validateMapping', () => {
    const ok: ColumnMapping[] = [
        { index: 0, target: 'name' },
        { index: 1, target: 'email' },
    ];

    it('accepts a name with an email or a phone', () => {
        expect(validateMapping(ok, 2)).toEqual([]);
        expect(
            validateMapping([{ index: 0, target: 'name' }, { index: 1, target: 'phone' }], 2),
        ).toEqual([]);
    });

    it('accepts split names', () => {
        expect(
            validateMapping(
                [{ index: 0, target: 'firstName' }, { index: 1, target: 'lastName' }, { index: 2, target: 'email' }],
                3,
            ),
        ).toEqual([]);
    });

    it('needs a name and an email or phone', () => {
        expect(validateMapping([{ index: 0, target: 'email' }], 2)).toEqual([
            'Map a column to Full name (or First name).',
        ]);
        expect(validateMapping([{ index: 0, target: 'name' }], 2)).toEqual([
            'Map a column to Email or Phone. They are how duplicates are found.',
        ]);
    });

    it('rejects a field mapped twice, a column mapped twice and a column that is not there', () => {
        expect(
            validateMapping([...ok, { index: 2, target: 'email' }], 3).join(' '),
        ).toMatch(/More than one column is mapped to Email/);
        expect(validateMapping([...ok, { index: 1, target: 'phone' }], 3).join(' ')).toMatch(
            /mapped twice/,
        );
        expect(validateMapping([...ok, { index: 9, target: 'phone' }], 3).join(' ')).toMatch(
            /not in the file/,
        );
        expect(validateMapping([...ok, { index: -1, target: 'phone' }], 3).join(' ')).toMatch(
            /not in the file/,
        );
    });

    it('rejects full name together with first or last name', () => {
        expect(
            validateMapping([...ok, { index: 2, target: 'firstName' }], 3).join(' '),
        ).toMatch(/either Full name or First name/);
    });

    it('checks new-field names', () => {
        expect(
            validateMapping([...ok, { index: 2, target: 'custom', label: ' ' }], 3).join(' '),
        ).toMatch(/needs a name/);
        expect(
            validateMapping(
                [...ok, { index: 2, target: 'custom', label: 'City' }, { index: 3, target: 'custom', label: 'city!' }],
                4,
            ).join(' '),
        ).toMatch(/Two columns would make the field/);
        expect(
            validateMapping([...ok, { index: 2, target: 'custom', label: 'Email' }], 3).join(' '),
        ).toMatch(/built-in field/);
    });

    it('lets skipped columns be anything', () => {
        expect(validateMapping([...ok, { index: 2, target: 'skip' }], 3)).toEqual([]);
    });
});
