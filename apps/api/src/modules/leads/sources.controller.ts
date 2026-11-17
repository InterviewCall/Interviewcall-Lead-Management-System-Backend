import { Body, Controller, Get, HttpCode, Ip, Param, Patch, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type CreateSourceBody, createSourceSchema, sourceIdSchema, type UpdateSourceBody, updateSourceSchema } from './leads.schemas.js';
import type { SourceAdminView } from './leads.types.js';
import { SourcesService } from './sources.service.js';

const WRITES = { limit: 30, windowSeconds: 60 } as const;

/** Where leads come from. Reading the active ones for pickers is GET /leads/filters; this is the admin's list. */
@Roles('ADMIN')
@Controller('sources')
export class SourcesController {
    constructor(private readonly sources: SourcesService) {}

    @Get()
    async list(): Promise<{ sources: SourceAdminView[] }> {
        return { sources: await this.sources.list() };
    }

    @Post()
    @HttpCode(201)
    @RateLimit(WRITES)
    create(@CurrentUser() auth: AuthContext, @Body({ schema: createSourceSchema }) body: CreateSourceBody, @Ip() ip: string | undefined): Promise<SourceAdminView> {
        return this.sources.create(auth, body, { ip });
    }

    /** Rename, change the kind, or switch on or off. The CRM's own sources answer 409 SOURCE_LOCKED. */
    @Patch(':id')
    @RateLimit(WRITES)
    update(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: sourceIdSchema }) id: number,
        @Body({ schema: updateSourceSchema }) body: UpdateSourceBody,
        @Ip() ip: string | undefined,
    ): Promise<SourceAdminView> {
        return this.sources.update(auth, id, body, { ip });
    }
}
