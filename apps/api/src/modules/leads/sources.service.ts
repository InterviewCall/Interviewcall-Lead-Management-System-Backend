import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { IamService } from '@modules/iam';
import { LeadsRepository } from './leads.repository.js';
import type { CreateSourceBody, UpdateSourceBody } from './leads.schemas.js';
import type { SourceAdminView } from './leads.types.js';

/** Sources the CRM finds by name, so renaming or switching them off would break intake or imports. */
const SYSTEM_NAMES = new Set(['WorkR', 'Organic', 'CSV import']);
const isSystem = (s: { name: string; matchRule: unknown }) => SYSTEM_NAMES.has(s.name) || (s.matchRule !== null && s.matchRule !== undefined);

/**
 * The lead sources an admin manages: where leads come from (Referral, Walk-in, an event). The CRM's own
 * sources (WorkR, the VSL ones, Organic, CSV import) are listed but locked. A source is never deleted, only
 * switched off, so old leads keep where they came from.
 */
@Injectable()
export class SourcesService {
    constructor(
        private readonly repository: LeadsRepository,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    async list(): Promise<SourceAdminView[]> {
        const rows = await this.repository.listAllSources();
        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            group: r.group,
            isActive: r.isActive,
            system: isSystem(r),
            leads: r.leads,
            createdAt: r.createdAt.toISOString(),
        }));
    }

    async create(auth: AuthContext, body: CreateSourceBody, meta: { ip?: string | null } = {}): Promise<SourceAdminView> {
        let id: number;
        try {
            id = await this.repository.createSource(body);
        } catch (error) {
            if (this.repository.isUniqueConflict(error)) throw this.nameTaken();
            throw error;
        }
        await this.audit(auth, AuditAction.SourceCreated, id, { group: body.group }, meta);
        return this.view(id);
    }

    async update(auth: AuthContext, id: number, body: UpdateSourceBody, meta: { ip?: string | null } = {}): Promise<SourceAdminView> {
        const source = await this.repository.findSourceById(id);
        if (!source) throw new NotFoundException({ code: 'SOURCE_NOT_FOUND', message: 'This source does not exist' });
        if (isSystem(source)) {
            throw new ConflictException({ code: 'SOURCE_LOCKED', message: `${source.name} is used by the CRM itself and cannot be changed here` });
        }
        try {
            await this.repository.updateSource(id, body);
        } catch (error) {
            if (this.repository.isUniqueConflict(error)) throw this.nameTaken();
            throw error;
        }
        await this.audit(auth, AuditAction.SourceUpdated, id, { fields: Object.keys(body) }, meta);
        return this.view(id);
    }

    private async view(id: number): Promise<SourceAdminView> {
        const found = (await this.list()).find((s) => s.id === id);
        if (!found) throw new NotFoundException({ code: 'SOURCE_NOT_FOUND', message: 'This source does not exist' });
        return found;
    }

    private nameTaken() {
        return new BadRequestException({ code: 'SOURCE_NAME_TAKEN', message: 'A source with this name already exists', fields: { name: 'A source with this name already exists' } });
    }

    private async audit(auth: AuthContext, action: AuditAction, id: number, detail: Record<string, unknown>, meta: { ip?: string | null }) {
        const actor = await this.iam.getStaffRef(auth.publicId);
        await this.admin.audit({ action, actorId: actor?.id ?? null, entityType: 'lead_source', entityId: String(id), detail, ip: meta.ip ?? null });
    }
}
