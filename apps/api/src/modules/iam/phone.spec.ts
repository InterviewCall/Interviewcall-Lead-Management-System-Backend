import { describe, expect, it } from 'vitest';
import { normalisePhone } from './phone.js';

describe('normalisePhone', () => {
    it.each([
        ['9876543210', '+919876543210'],
        ['98765 43210', '+919876543210'],
        ['98765-43210', '+919876543210'],
        ['09876543210', '+919876543210'],
        ['919876543210', '+919876543210'],
        ['+91 98765 43210', '+919876543210'],
        ['+91-(98765)-43210', '+919876543210'],
        ['  6000000000  ', '+916000000000'],
        ['+44 7911 123456', '+447911123456'],
        ['+971501234567', '+971501234567'],
    ])('turns %s into %s', (input, expected) => {
        expect(normalisePhone(input)).toBe(expected);
    });

    it.each([
        [''],
        ['   '],
        ['12345'],
        ['5876543210'], // an Indian mobile number starts with 6 to 9
        ['98765432100'], // eleven digits that do not start with 0
        ['+0123456789'],
        ['+1234567'], // too short
        ['+1234567890123456'], // too long
        ['98765abcde'],
        ['98765 43210 ext 5'],
    ])('refuses %j', (input) => {
        expect(normalisePhone(input)).toBeNull();
    });
});
