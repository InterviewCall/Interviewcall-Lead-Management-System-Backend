import { Body, Controller, Get, Ip, Param, Patch, Post, HttpCode } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import {
    type CreateCustomFieldBody,
    createCustomFieldSchema,
    customKeySchema,
    type UpdateCustomFieldBody,
    updateCustomFieldSchema,
} from './leads.schemas.js';
import { CustomFieldsService } from './custom-fields.service.js';

/** The extra fields on a lead. Everyone reads the ones their role may see; admins change them. */
@Controller('custom-fields')
export class CustomFieldsController {
    constructor(private readonly fields: CustomFieldsService) {}

    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get()
    list(@CurrentUser() auth: AuthContext) {
        return this.fields.list(auth);
    }

    @Roles('ADMIN')
    @Post()
    @HttpCode(201)
    @RateLimit({ limit: 30, windowSeconds: 60 })
    create(@CurrentUser() auth: AuthContext, @Body({ schema: createCustomFieldSchema }) body: CreateCustomFieldBody, @Ip() ip: string) {
        return this.fields.create(auth, body, ip);
    }

    /** Rename, change options, who sees it, whether it is required, or retire it. The type never changes. */
    @Roles('ADMIN')
    @Patch(':key')
    @RateLimit({ limit: 60, windowSeconds: 60 })
    update(
        @CurrentUser() auth: AuthContext,
        @Param('key', { schema: customKeySchema }) key: string,
        @Body({ schema: updateCustomFieldSchema }) body: UpdateCustomFieldBody,
        @Ip() ip: string,
    ) {
        return this.fields.update(auth, key, body, ip);
    }
}
