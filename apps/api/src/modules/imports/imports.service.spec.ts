import { ForbiddenException } from '@nestjs/common';
import { ImportsService } from './imports.service.js';

const stub = (): never => ({}) as never;

function build(overrides: { iam?: object; leads?: object } = {}) {
    const iam = overrides.iam ?? { getStaffRef: async () => null, listActiveStaff: async () => [] };
    const leads = overrides.leads ?? {
        listSources: async () => [],
        listCustomFields: async () => [],
    };
    return new ImportsService(
        stub(),
        leads as never,
        stub(),
        stub(),
        stub(),
        iam as never,
        stub(),
        stub(),
    );
}

const csvFile = { buffer: Buffer.from('a,b\n1,2\n'), originalname: 'x.csv', size: 8, mimetype: 'text/csv' };

describe('ImportsService access rules', () => {
    const blocked = ['BDA', 'CLOSER', 'OPS'] as const;

    it.each(blocked)('refuses %s before touching any data', async (role) => {
        const service = build();
        const auth = { publicId: 'u1', role } as never;
        await expect(service.options(auth)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.createFromUpload(auth, csvFile as never)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        await expect(service.list(auth, {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each(['ADMIN', 'SALES_MANAGER'] as const)('lets %s read the options', async (role) => {
        const service = build();
        const result = await service.options({ publicId: 'u1', role } as never);
        expect(result).toBeDefined();
    });

    it('refuses an allowed role whose account is inactive', async () => {
        const service = build({
            iam: { getStaffRef: async () => ({ isActive: false }), listActiveStaff: async () => [] },
        });
        await expect(
            service.createFromUpload({ publicId: 'u1', role: 'ADMIN' } as never, csvFile as never),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });
});
