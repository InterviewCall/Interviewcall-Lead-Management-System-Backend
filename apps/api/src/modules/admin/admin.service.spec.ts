import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRepository } from './admin.repository.js';
import { AdminService } from './admin.service.js';
import { AuditAction, type AuditEntry } from './audit.types.js';

describe('AdminService', () => {
    const entry: AuditEntry = {
        action: AuditAction.StaffCreated,
        actorId: 1n,
        entityType: 'staff',
        entityId: 'abc',
        detail: { role: 'CLOSER' },
        ip: '10.0.0.1',
    };

    async function serviceWith(repository: Partial<AdminRepository>) {
        const moduleRef = await Test.createTestingModule({
            providers: [
                AdminService,
                { provide: AdminRepository, useValue: repository },
            ],
        }).compile();
        return moduleRef.get(AdminService);
    }

    it('writes the audit entry through the repository', async () => {
        const insertAudit = vi.fn().mockResolvedValue(undefined);
        const service = await serviceWith({ insertAudit });

        await service.audit(entry);

        expect(insertAudit).toHaveBeenCalledWith(entry);
    });

    it('does not throw when the audit write fails, and logs no detail', async () => {
        const error = vi
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);
        const service = await serviceWith({
            insertAudit: vi
                .fn()
                .mockRejectedValue(new Error('Table is full: secret')),
        });

        await expect(service.audit(entry)).resolves.toBeUndefined();

        const message = String(error.mock.calls[0][0]);
        expect(message).toContain('staff.created');
        expect(message).not.toContain('CLOSER');
        expect(message).not.toContain('secret');
        error.mockRestore();
    });
});
