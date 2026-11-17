import { depthWeight, priorityRankOf } from './vsl-priority.js';

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
