import {
    Body,
    Controller,
    Get,
    HttpCode,
    Ip,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import type { StaffListItem, StaffView } from './iam.types.js';
import {
    type CreateStaffBody,
    createStaffSchema,
    type ListStaffQuery,
    listStaffQuerySchema,
    staffIdSchema,
    type UpdateStaffBody,
    updateStaffSchema,
} from './staff.schemas.js';
import { StaffService } from './staff.service.js';

/** Admin writes: 30 a minute per admin. Generous for people, tight for a script. */
const STAFF_WRITES = { limit: 30, windowSeconds: 60 } as const;

/** Everything here is for admins. A route that should be open to other roles says so with its own @Roles. */
@Roles('ADMIN')
@Controller('staff')
export class StaffController {
    constructor(private readonly staff: StaffService) {}

    /** One page of staff, newest first. Filter with ?search=, ?role=, ?status=; page with ?page= and ?pageSize=. */
    @Get()
    list(
        @CurrentUser() auth: AuthContext,
        @Query({ schema: listStaffQuerySchema }) query: ListStaffQuery,
    ): Promise<{
        staff: StaffListItem[];
        page: number;
        pageSize: number;
        total: number;
    }> {
        return this.staff.list(auth, query);
    }

    /** Creates the account and emails its one-time password. The password is never in the response. */
    @Post()
    @HttpCode(201)
    @RateLimit(STAFF_WRITES)
    async create(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: createStaffSchema }) body: CreateStaffBody,
        @Ip() ip: string | undefined,
    ): Promise<{ staff: StaffView }> {
        return {
            staff: await this.staff.create(auth, body, {
                ip,
                userAgent: undefined,
            }),
        };
    }

    /** Changes a name or a role. */
    @Patch(':id')
    @RateLimit(STAFF_WRITES)
    async update(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: staffIdSchema }) id: string,
        @Body({ schema: updateStaffSchema }) body: UpdateStaffBody,
        @Ip() ip: string | undefined,
    ): Promise<{ staff: StaffView }> {
        return {
            staff: await this.staff.update(auth, id, body, {
                ip,
                userAgent: undefined,
            }),
        };
    }

    /** Switches the account off and ends its sessions. */
    @Post(':id/deactivate')
    @HttpCode(200)
    @RateLimit(STAFF_WRITES)
    async deactivate(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: staffIdSchema }) id: string,
        @Ip() ip: string | undefined,
    ): Promise<{ staff: StaffView }> {
        return {
            staff: await this.staff.deactivate(auth, id, {
                ip,
                userAgent: undefined,
            }),
        };
    }

    /** Switches a deactivated account back on with a new one-time password. */
    @Post(':id/reactivate')
    @HttpCode(200)
    @RateLimit(STAFF_WRITES)
    async reactivate(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: staffIdSchema }) id: string,
        @Ip() ip: string | undefined,
    ): Promise<{ staff: StaffView }> {
        return {
            staff: await this.staff.reactivate(auth, id, {
                ip,
                userAgent: undefined,
            }),
        };
    }

    /** Issues a new one-time password, ends the user's sessions and emails the new password. */
    @Post(':id/reset-password')
    @HttpCode(200)
    @RateLimit(STAFF_WRITES)
    async resetPassword(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: staffIdSchema }) id: string,
        @Ip() ip: string | undefined,
    ): Promise<{ staff: StaffView }> {
        return {
            staff: await this.staff.resetPassword(auth, id, {
                ip,
                userAgent: undefined,
            }),
        };
    }
}
