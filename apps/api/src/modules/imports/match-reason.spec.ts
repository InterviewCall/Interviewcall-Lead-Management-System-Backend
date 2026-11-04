import { describeMatch, duplicateMessage } from './match-reason.js';

describe('describeMatch', () => {
    it.each([
        [['EMAIL'], 'same email'],
        [['PHONE'], 'same phone'],
        [['EMAIL', 'PHONE'], 'same email and phone'],
        [['PHONE', 'EMAIL'], 'same email and phone'],
        [[], ''],
    ] as const)('%j is %j', (on, expected) => {
        expect(describeMatch([...on])).toBe(expected);
    });
});

describe('duplicateMessage', () => {
    it('names the existing lead case', () => {
        expect(duplicateMessage(null, ['PHONE'])).toBe('Already a lead (same phone)');
        expect(duplicateMessage(null, [])).toBe('Already a lead');
    });

    it('names the repeat-in-file case with its first row', () => {
        expect(duplicateMessage(4, ['EMAIL'])).toBe('Repeated in this file (row 4, same email)');
        expect(duplicateMessage(4, [])).toBe('Repeated in this file (row 4)');
    });
});
