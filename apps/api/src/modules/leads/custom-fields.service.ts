import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext, Role } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { IamService } from '@modules/iam';
import { type FieldTypeName, keyFromLabel } from './custom-fields.js';
import { LeadsRepository } from './leads.repository.js';
import type { CreateCustomFieldBody, UpdateCustomFieldBody } from './leads.schemas.js';

interface DefRow {
    key: string;
    label: string;
    type: FieldTypeName;
    options: unknown;
    isRequired: boolean;
    visibleRoles: unknown;
    isActive: boolean;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const toFieldView = (r: DefRow) => ({
    key: r.key,
    label: r.label,
    type: r.type,
    options: asList(r.options),
    required: r.isRequired,
    visibleRoles: asList(r.visibleRoles) as Role[],
    active: r.isActive,
});

/** The extra fields an admin adds to a lead (batch preference, target company, anything the team tracks). */
@Injectable()
export class CustomFieldsService {
    constructor(
        private readonly repository: LeadsRepository,
        private readonly iam: IamService,
        private readonly admin: AdminService,
    ) {}

    /** Admins see every field including retired ones; everyone else only the active fields their role may see. */
    async list(auth: AuthContext) {
        const rows = (await this.repository.listCustomFieldDefs()) as unknown as DefRow[];
        const views = rows.map(toFieldView);
        return { fields: auth.role === 'ADMIN' ? views : views.filter((f) => f.active && f.visibleRoles.includes(auth.role as Role)) };
    }

    async create(auth: AuthContext, body: CreateCustomFieldBody, ip: string | null) {
        const key = keyFromLabel(body.label);
        if (!key) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Use letters or digits in the name', fields: { label: 'Use letters or digits in the name' } });
        if (await this.repository.findCustomFieldDef(key)) {
            throw new ConflictException({ code: 'FIELD_EXISTS', message: 'A field with this name already exists', fields: { label: 'A field with this name already exists' } });
        }
        const choices = body.type === 'SELECT' || body.type === 'MULTISELECT';
        const row = await this.repository.createCustomFieldDef({
            key, label: body.label, type: body.type, options: choices ? body.options : null, isRequired: body.isRequired, visibleRoles: body.visibleRoles,
        });
        await this.audit(auth, AuditAction.CustomFieldCreated, key, ip);
        return toFieldView(row as unknown as DefRow);
    }

    async update(auth: AuthContext, key: string, body: UpdateCustomFieldBody, ip: string | null) {
        const current = await this.repository.findCustomFieldDef(key);
        if (!current) throw new NotFoundException({ code: 'FIELD_NOT_FOUND', message: 'This field does not exist' });
        const choices = current.type === 'SELECT' || current.type === 'MULTISELECT';
        if (body.options !== undefined && !choices) {
            throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Only a choice field has options', fields: { options: 'Only a choice field has options' } });
        }
        if (body.options !== undefined && body.options.length < 2) {
            throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Add at least two options', fields: { options: 'Add at least two options' } });
        }
        const row = await this.repository.updateCustomFieldDef(key, body);
        await this.audit(auth, AuditAction.CustomFieldUpdated, key, ip);
        return toFieldView(row as unknown as DefRow);
    }

    private async audit(auth: AuthContext, action: (typeof AuditAction)[keyof typeof AuditAction], key: string, ip: string | null) {
        const actor = await this.iam.getStaffRef(auth.publicId);
        await this.admin.audit({ action, actorId: actor?.id ?? null, entityType: 'custom_field', entityId: key, detail: {}, ip });
    }
}
