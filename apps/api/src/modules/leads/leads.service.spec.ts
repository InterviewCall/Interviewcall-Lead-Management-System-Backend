import { LeadsService } from './leads.service.js';

function build(repo: object = {}) {
    return new LeadsService(repo as never, {} as never, {} as never);
}

describe('LeadsService.addScore validation', () => {
    it.each([0, 1.5, Number.NaN])('rejects %s points', async (points) => {
        await expect(build().addScore(1n, points, 'Email opened')).rejects.toThrow();
    });

    it('rejects a blank or over-long reason', async () => {
        await expect(build().addScore(1n, 5, '  ')).rejects.toThrow();
        await expect(build().addScore(1n, 5, 'x'.repeat(61))).rejects.toThrow();
    });

    it('passes a valid entry to the repository', async () => {
        const calls: unknown[][] = [];
        const service = build({ addScore: async (...args: unknown[]) => void calls.push(args) });
        await service.addScore(7n, 10, 'Replied', 'ref-1');
        expect(calls).toHaveLength(1);
    });
});
