import { PasswordService } from './password.service.js';

describe('PasswordService.generateTemporary', () => {
    const service = new PasswordService();

    it('makes 14 characters from an alphabet without look-alike characters', () => {
        for (let i = 0; i < 50; i++) {
            const password = service.generateTemporary();
            expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{14}$/);
        }
    });

    it('does not repeat', () => {
        const seen = new Set(
            Array.from({ length: 200 }, () => service.generateTemporary()),
        );
        expect(seen.size).toBe(200);
    });

    it('produces a password that hashes and verifies', async () => {
        const password = service.generateTemporary();
        const hash = await service.hash(password);

        expect(hash.startsWith('$argon2id$')).toBe(true);
        await expect(service.verify(hash, password)).resolves.toBe(true);
        await expect(service.verify(hash, `${password}x`)).resolves.toBe(false);
    });

    it('treats a malformed stored hash as a failed check, not an error', async () => {
        await expect(service.verify('not-a-hash', 'whatever')).resolves.toBe(
            false,
        );
    });
});
