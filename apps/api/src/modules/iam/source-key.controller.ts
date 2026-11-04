import { Body, Controller, Get, HttpCode, Ip, Param, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import type { SourceKeyView } from './iam.types.js';
import {
    type CreateSourceKeyBody,
    createSourceKeySchema,
    sourceKeyIdSchema,
} from './source-key.schemas.js';
import { SourceKeyService } from './source-key.service.js';

const KEY_WRITES = { limit: 20, windowSeconds: 60 } as const;

/** The keys WorkR and the VSL services use to call the intake API. Admins only. */
@Roles('ADMIN')
@Controller('source-keys')
export class SourceKeyController {
    constructor(private readonly keys: SourceKeyService) {}

    @Get()
    async list(): Promise<{ keys: SourceKeyView[] }> {
        return { keys: await this.keys.list() };
    }

    /** The response carries the key itself, once. It cannot be read again. */
    @Post()
    @HttpCode(201)
    @RateLimit(KEY_WRITES)
    create(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: createSourceKeySchema }) body: CreateSourceKeyBody,
        @Ip() ip: string | undefined,
    ): Promise<{ key: string; sourceKey: SourceKeyView }> {
        return this.keys.create(auth, body, { ip });
    }

    @Post(':id/revoke')
    @HttpCode(200)
    @RateLimit(KEY_WRITES)
    async revoke(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: sourceKeyIdSchema }) id: number,
        @Ip() ip: string | undefined,
    ): Promise<{ sourceKey: SourceKeyView }> {
        return { sourceKey: await this.keys.revoke(auth, id, { ip }) };
    }
}
