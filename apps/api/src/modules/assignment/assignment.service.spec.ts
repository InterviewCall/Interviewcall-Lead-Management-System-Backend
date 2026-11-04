import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AssignmentService, WORKR_BATCH_PREFIX } from './assignment.service.js';

const admin = { publicId: 'u-admin', role: 'ADMIN' } as AuthContext;
const bdaAuth = { publicId: 'u-bda', role: 'BDA' } as AuthContext;
const manager = { id: 2n, publicId: 'u-mgr', name: 'Mira', role: 'SALES_MANAGER', isActive: true };
const lead = (id: number, ownerId = 1n) => ({ id: BigInt(id), ownerId, firstSourceId: 3, vslDepth: null, temperature: null });

function build() {
    const repository = { insertMany: vi.fn().mockResolvedValue(undefined), hasBatchEntry: vi.fn(), insertSystemEntry: vi.fn() };
    const leads = {
        findListByPublicId: vi.fn().mockResolvedValue({ id: 10n, publicId: 'l-1', originRef: `${WORKR_BATCH_PREFIX}2026-11-05`, createdById: 1n }),
        findListLeadsOwnedBy: vi.fn().mockResolvedValue([lead(1), lead(2)]),
        findAssignableByPublicIds: vi.fn(),
        reassignOwner: vi.fn(async (moves: { id: bigint }[]) => moves.map((m) => m.id)),
        listBatches: vi.fn(),
    };
    const iam = {
        getStaffRef: vi.fn(async (id: string) => (id === 'u-mgr' ? manager : { id: 1n, publicId: 'u-admin', name: 'Anu', role: 'ADMIN', isActive: true })),
        listActiveStaff: vi.fn().mockResolvedValue([]),
        getStaffNames: vi.fn().mockResolvedValue(new Map([[1n, 'Anu']])),
    };
    const pipeline = { reassignOpenOpportunities: vi.fn().mockResolvedValue(undefined) };
    const timeline = { appendMany: vi.fn().mockResolvedValue(undefined) };
    const audit = { audit: vi.fn().mockResolvedValue(undefined) };
    // oxlint-disable-next-line no-explicit-any
    const service = new AssignmentService(repository as any, leads as any, iam as any, pipeline as any, timeline as any, audit as any);
    return { service, repository, leads, iam, pipeline, timeline, audit };
}

describe('AssignmentService', () => {
    it('lets only admins and sales managers distribute', async () => {
        const { service } = build();
        await expect(service.assignees(bdaAuth)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.batches(bdaAuth)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.handOver(bdaAuth, { listId: 'l-1', toUserId: 'u-mgr' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.bulkAssign(bdaAuth, { leadIds: ['x'], toUserId: 'u-mgr' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('hands a batch over: owner, open opportunity, log, timeline and audit all follow', async () => {
        const { service, leads, pipeline, repository, timeline, audit } = build();
        const res = await service.handOver(admin, { listId: 'l-1', toUserId: 'u-mgr' });
        expect(res).toEqual({ moved: 2, skipped: 0, to: { id: 'u-mgr', name: 'Mira' } });
        expect(leads.reassignOwner).toHaveBeenCalledWith([{ id: 1n, fromOwnerId: 1n }, { id: 2n, fromOwnerId: 1n }], 2n);
        expect(pipeline.reassignOpenOpportunities).toHaveBeenCalledWith([1n, 2n], 2n);
        const lines = repository.insertMany.mock.calls[0][0] as { method: string; reasonCode: string; batchId: string }[];
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ method: 'BULK', reasonCode: 'HANDOVER', toUserId: 2n, fromUserId: 1n });
        expect(new Set(lines.map((l) => l.batchId)).size).toBe(1);
        expect(timeline.appendMany).toHaveBeenCalledOnce();
        expect(audit.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'assignment.handover', entityId: 'l-1' }));
    });

    it('counts a lead someone else grabbed in the meantime as skipped, not moved', async () => {
        const { service, leads, repository } = build();
        leads.reassignOwner.mockResolvedValueOnce([1n] as never);
        const res = await service.handOver(admin, { listId: 'l-1', toUserId: 'u-mgr' });
        expect(res).toMatchObject({ moved: 1, skipped: 1 });
        expect((repository.insertMany.mock.calls[0][0] as unknown[]).length).toBe(1);
    });

    it('refuses an unknown list, a list that is not a WorkR batch, nothing waiting, the same owner and an invalid assignee', async () => {
        const a = build();
        a.leads.findListByPublicId.mockResolvedValueOnce(null as never);
        await expect(a.service.handOver(admin, { listId: 'x', toUserId: 'u-mgr' })).rejects.toBeInstanceOf(NotFoundException);

        const b = build();
        b.leads.findListByPublicId.mockResolvedValueOnce({ id: 1n, publicId: 'l', originRef: null, createdById: 1n } as never);
        await expect(b.service.handOver(admin, { listId: 'l', toUserId: 'u-mgr' })).rejects.toBeInstanceOf(NotFoundException);

        const c = build();
        c.leads.findListLeadsOwnedBy.mockResolvedValueOnce([] as never);
        await expect(c.service.handOver(admin, { listId: 'l-1', toUserId: 'u-mgr' })).rejects.toMatchObject({ response: { code: 'NOTHING_TO_HAND_OVER' } });

        const d = build();
        await expect(d.service.handOver(admin, { listId: 'l-1', toUserId: 'u-admin' })).rejects.toBeInstanceOf(ConflictException);
        expect(d.leads.reassignOwner).not.toHaveBeenCalled();

        const e = build();
        e.iam.getStaffRef.mockImplementation(async () => ({ ...manager, role: 'CLOSER' }));
        await expect(e.service.handOver(admin, { listId: 'l-1', toUserId: 'u-mgr' })).rejects.toBeInstanceOf(BadRequestException);
        e.iam.getStaffRef.mockImplementation(async () => ({ ...manager, isActive: false }));
        await expect(e.service.handOver(admin, { listId: 'l-1', toUserId: 'u-mgr' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bulk assign skips leads already with the target and ids that were not found', async () => {
        const { service, leads, repository } = build();
        leads.findAssignableByPublicIds.mockResolvedValueOnce([lead(1), lead(2, 2n)] as never);
        const res = await service.bulkAssign(admin, { leadIds: ['a', 'b', 'ghost', 'a'], toUserId: 'u-mgr' });
        expect(res).toMatchObject({ moved: 1, skipped: 2 }); // one already theirs + one not found
        expect((repository.insertMany.mock.calls[0][0] as { reasonCode: string }[])[0].reasonCode).toBe('BULK_ASSIGN');
    });

    it('lists batches with their waiting counts and owner names', async () => {
        const { service, leads } = build();
        leads.listBatches.mockResolvedValueOnce([{ publicId: 'l-1', name: 'WorkR signups · 5 Nov 2026', createdAt: new Date('2026-11-05T00:00:00Z'), total: 3, waiting: 2, ownerId: 1n }] as never);
        const res = await service.batches(admin);
        expect(res.batches[0]).toMatchObject({ id: 'l-1', total: 3, waiting: 2, ownerName: 'Anu' });
        expect(leads.listBatches).toHaveBeenCalledWith(WORKR_BATCH_PREFIX, 30);
    });
});
