import { Injectable } from '@nestjs/common';
import type { Role } from '@app/rbac';
import { IamRepository } from './iam.repository.js';
import type { StaffRef } from './iam.types.js';

@Injectable()
export class IamService {
    constructor(private readonly repository: IamRepository) {}

    /** The staff user with this public id, or null. Includes deactivated accounts; check `isActive`. */
    getStaffRef(publicId: string): Promise<StaffRef | null> {
        return this.repository.findStaffRef(publicId);
    }

    /** Display names for these internal ids (including deactivated accounts). */
    getStaffNames(ids: bigint[]): Promise<Map<bigint, string>> {
        return this.repository.findStaffNames(ids);
    }

    /** The active staff user with this email, or null. */
    async getActiveStaffByEmail(email: string): Promise<StaffRef | null> {
        const account = await this.repository.findStaffByEmail(email.trim().toLowerCase());
        if (!account || !account.isActive) return null;
        return { id: account.id, publicId: account.publicId, name: account.name, role: account.role, isActive: true };
    }

    /** Active staff in these roles, for pickers like "who should own these leads". */
    listActiveStaff(roles: Role[]): Promise<StaffRef[]> {
        return this.repository.listActiveStaffRefs(roles);
    }
}
