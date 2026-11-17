import { Body, Controller, Get, Ip, Patch, Query } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type AuditQuery, auditQuerySchema } from './admin.schemas.js';
import { AdminService } from './admin.service.js';
import { type UpdateSettingsBody, updateSettingsSchema } from './settings.js';

/** The audit log and the settings. Admins only. */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
    constructor(private readonly admin: AdminService) {}

    /** Who did what, newest first. Filter by action, person, record and day. */
    @Get('audit')
    audit(@Query({ schema: auditQuerySchema }) query: AuditQuery) {
        return this.admin.listAudit(query);
    }

    /** The actions seen so far, for the filter. */
    @Get('audit/actions')
    async actions() {
        return { actions: await this.admin.auditActions() };
    }

    @Get('settings')
    async settings() {
        return { settings: await this.admin.getSettings() };
    }

    @Patch('settings')
    @RateLimit({ limit: 30, windowSeconds: 60 })
    async updateSettings(@CurrentUser() auth: AuthContext, @Body({ schema: updateSettingsSchema }) body: UpdateSettingsBody, @Ip() ip: string) {
        return { settings: await this.admin.updateSettings(auth, body, ip) };
    }
}
