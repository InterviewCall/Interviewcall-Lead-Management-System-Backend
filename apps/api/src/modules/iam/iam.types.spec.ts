import { Role as DatabaseRole } from '@app/prisma/enums.js';
import { ROLES } from '@app/rbac';

describe('roles', () => {
    it('are the same in the RBAC library and the database enum', () => {
        // If this fails, a role was added to one and not the other: update both, and the migration.
        expect([...ROLES].sort()).toEqual(Object.values(DatabaseRole).sort());
    });
});
