import { checkFieldValue, keyFromLabel } from './custom-fields.js';

const f = (type: Parameters<typeof checkFieldValue>[0]['type'], options: string[] = []) => ({ label: 'Batch', type, options });

describe('custom field values', () => {
    it('makes a key from a label', () => {
        expect(keyFromLabel('  Preferred batch! ')).toBe('preferred_batch');
        expect(keyFromLabel('CTC (LPA)')).toBe('ctc_lpa');
    });

    it('clears on an empty value', () => {
        for (const raw of [null, undefined, '', []]) expect(checkFieldValue(f('TEXT'), raw)).toEqual({ ok: true, value: null });
    });

    it('checks each type', () => {
        expect(checkFieldValue(f('TEXT'), ' hi ')).toEqual({ ok: true, value: 'hi' });
        expect(checkFieldValue(f('NUMBER'), '12.5')).toEqual({ ok: true, value: 12.5 });
        expect(checkFieldValue(f('NUMBER'), 'abc').ok).toBe(false);
        expect(checkFieldValue(f('DATE'), '2026-11-30')).toEqual({ ok: true, value: '2026-11-30' });
        expect(checkFieldValue(f('DATE'), '2026-13-40').ok).toBe(false);
        expect(checkFieldValue(f('SELECT', ['A', 'B']), 'B')).toEqual({ ok: true, value: 'B' });
        expect(checkFieldValue(f('SELECT', ['A', 'B']), 'C').ok).toBe(false);
        expect(checkFieldValue(f('MULTISELECT', ['A', 'B']), ['A', 'A', 'B'])).toEqual({ ok: true, value: ['A', 'B'] });
        expect(checkFieldValue(f('MULTISELECT', ['A']), ['Z']).ok).toBe(false);
        expect(checkFieldValue(f('BOOLEAN'), false)).toEqual({ ok: true, value: false });
        expect(checkFieldValue(f('BOOLEAN'), 'yes').ok).toBe(false);
    });
});
