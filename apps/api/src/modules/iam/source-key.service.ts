import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '@app/rbac';
import { AdminService, AuditAction } from '@modules/admin';
import { IamRepository } from './iam.repository.js';
import type {
    SourceIdentity,
    SourceKeyRecord,
    SourceKeyView,
    SourceSystemName,
} from './iam.types.js';

/** How often a key's "last used" time is refreshed, so a busy sender does not write on every request. */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const toView = (record: SourceKeyRecord): SourceKeyView => ({
    id: record.id,
    name: record.name,
    system: record.system,
    prefix: record.keyPrefix,
    active: record.isActive,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
});

/**
 * The API keys the sender services (WorkR, the VSL) use to call the intake API. A key is shown
 * once when it is made; only its hash is stored, so a lost key is replaced, never recovered.
 */
@Injectable()
export class SourceKeyService {
    constructor(
        private readonly repository: IamRepository,
        private readonly admin: AdminService,
    ) {}

    async list(): Promise<SourceKeyView[]> {
        return (await this.repository.listSourceCredentials()).map(toView);
    }

    /** Makes a key. The returned `key` is the only time it can be read. */
    async create(
        auth: AuthContext,
        input: { name: string; system: SourceSystemName },
        meta: { ip?: string | null } = {},
    ): Promise<{ key: string; sourceKey: SourceKeyView }> {
        const key = `ick_${randomBytes(30).toString('base64url')}`;
        const record = await this.repository.createSourceCredential({
            name: input.name,
            system: input.system,
            keyPrefix: key.slice(0, 8),
            keyHash: sha256(key),
        });
        if (!record) {
            throw new ConflictException({
                code: 'KEY_NAME_TAKEN',
                message: 'A key with this name already exists. Choose another name',
                fields: { name: 'A key with this name already exists' },
            });
        }
        await this.admin.audit({
            action: AuditAction.SourceKeyCreated,
            actorId: (await this.actorId(auth)) ?? null,
            entityType: 'source_key',
            entityId: String(record.id),
            detail: { system: record.system },
            ip: meta.ip ?? null,
        });
        return { key, sourceKey: toView(record) };
    }

    async revoke(auth: AuthContext, id: number, meta: { ip?: string | null } = {}): Promise<SourceKeyView> {
        const record = await this.repository.revokeSourceCredential(id, new Date());
        if (!record) {
            throw new NotFoundException({ code: 'KEY_NOT_FOUND', message: 'That key no longer exists' });
        }
        await this.admin.audit({
            action: AuditAction.SourceKeyRevoked,
            actorId: (await this.actorId(auth)) ?? null,
            entityType: 'source_key',
            entityId: String(record.id),
            detail: { system: record.system },
            ip: meta.ip ?? null,
        });
        return toView(record);
    }

    /** Who this key belongs to, or null when it is missing, unknown or revoked. */
    async verify(key: string | undefined): Promise<SourceIdentity | null> {
        if (!key || key.length < 20 || key.length > 200) return null;
        const record = await this.repository.findActiveSourceCredential(sha256(key));
        if (!record) return null;
        const now = Date.now();
        if (!record.lastUsedAt || now - record.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
            // Best effort: a failed bookkeeping write must not reject a good key.
            await this.repository.touchSourceCredential(record.id, new Date(now)).catch(() => undefined);
        }
        return { id: record.id, name: record.name, system: record.system };
    }

    private async actorId(auth: AuthContext): Promise<bigint | undefined> {
        return (await this.repository.findStaffRef(auth.publicId))?.id;
    }
}
