import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type CreateSavedViewBody, createSavedViewSchema, savedViewIdSchema } from './leads.schemas.js';
import { SavedViewsService } from './saved-views.service.js';

/** Saved filter sets for the leads list. */
@Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
@Controller('saved-views')
export class SavedViewsController {
    constructor(private readonly views: SavedViewsService) {}

    @Get()
    list(@CurrentUser() auth: AuthContext) {
        return this.views.list(auth);
    }

    @Post()
    @HttpCode(201)
    @RateLimit({ limit: 30, windowSeconds: 60 })
    create(@CurrentUser() auth: AuthContext, @Body({ schema: createSavedViewSchema }) body: CreateSavedViewBody) {
        return this.views.create(auth, body);
    }

    @Delete(':id')
    @HttpCode(204)
    @RateLimit({ limit: 30, windowSeconds: 60 })
    async remove(@CurrentUser() auth: AuthContext, @Param('id', { schema: savedViewIdSchema }) id: number) {
        await this.views.remove(auth, id);
    }
}
