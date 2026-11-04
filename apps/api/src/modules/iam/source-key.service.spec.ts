import { createHash } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { SourceKeyService } from './source-key.service.js';

const auth = { publicId: 'admin-1', role: 'ADMIN' } as AuthContext;
const record = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'WorkR',
    system: 'WORKR',
    keyPrefix: 'ick_abcd',
    isActive: true,
    lastUsedAt: null,
    createdAt: new Date('2026-11-05T00:00:00Z'),
    revokedAt: null,
    ...over,
});

function build() {
    const repository = {
        createSourceCredential: vi.fn(async (input: Record<string, unknown>) => record({ keyPrefix: input.keyPrefix })),
        findActiveSourceCredential: vi.fn(),
        touchSourceCredential: vi.fn().mockResolvedValue(undefined),
        listSourceCredentials: vi.fn().mockResolvedValue([record()]),
        revokeSourceCredential: vi.fn(),
        findStaffRef: vi.fn().mockResolvedValue({ id: 1n }),
    };
    const admin = { audit: vi.fn().mockResolvedValue(undefined) };
    // oxlint-disable-next-line no-explicit-any
    return { repository, admin, service: new SourceKeyService(repository as any, admin as any) };
}

describe('SourceKeyService', () => {
    it('shows the key once and stores only its hash and first characters', async () => {
        const { service, repository, admin } = build();
        const { key, sourceKey } = await service.create(auth, { name: 'WorkR', system: 'WORKR' });
        expect(key).toMatch(/^ick_[A-Za-z0-9_-]{40}$/);
        const stored = repository.createSourceCredential.mock.calls[0][0] as Record<string, string>;
        expect(stored.keyHash).toBe(createHash('sha256').update(key).digest('hex'));
        expect(stored.keyPrefix).toBe(key.slice(0, 8));
        expect(JSON.stringify(stored)).not.toContain(key);
        expect(JSON.stringify(sourceKey)).not.toContain(key);
        expect(admin.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'source_key.created' }));
    });

    it('reports a name already in use', async () => {
        const { service, repository } = build();
        repository.createSourceCredential.mockResolvedValueOnce(null as never);
        await expect(service.create(auth, { name: 'WorkR', system: 'WORKR' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('revokes a key, and 404s on an unknown one', async () => {
        const { service, repository, admin } = build();
        repository.revokeSourceCredential.mockResolvedValueOnce(record({ isActive: false, revokedAt: new Date() }) as never);
        expect((await service.revoke(auth, 7)).active).toBe(false);
        expect(admin.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'source_key.revoked' }));
        repository.revokeSourceCredential.mockResolvedValueOnce(null as never);
        await expect(service.revoke(auth, 8)).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('verify', () => {
        const key = `ick_${'a'.repeat(40)}`;
        it('rejects a missing, short or unknown key without touching the database for obvious junk', async () => {
            const { service, repository } = build();
            expect(await service.verify(undefined)).toBeNull();
            expect(await service.verify('short')).toBeNull();
            expect(repository.findActiveSourceCredential).not.toHaveBeenCalled();
            repository.findActiveSourceCredential.mockResolvedValueOnce(null as never);
            expect(await service.verify(key)).toBeNull();
        });

        it('looks the key up by its hash and identifies the system', async () => {
            const { service, repository } = build();
            repository.findActiveSourceCredential.mockResolvedValueOnce(record() as never);
            expect(await service.verify(key)).toEqual({ id: 7, name: 'WorkR', system: 'WORKR' });
            expect(repository.findActiveSourceCredential).toHaveBeenCalledWith(createHash('sha256').update(key).digest('hex'));
        });

        it('refreshes last-used at most every five minutes, and survives a failed refresh', async () => {
            const { service, repository } = build();
            repository.findActiveSourceCredential.mockResolvedValue(record({ lastUsedAt: new Date() }) as never);
            await service.verify(key);
            expect(repository.touchSourceCredential).not.toHaveBeenCalled();
            repository.findActiveSourceCredential.mockResolvedValue(record({ lastUsedAt: new Date(Date.now() - 10 * 60_000) }) as never);
            repository.touchSourceCredential.mockRejectedValueOnce(new Error('db'));
            expect(await service.verify(key)).not.toBeNull();
            expect(repository.touchSourceCredential).toHaveBeenCalledTimes(1);
        });
    });
});
