import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { notificationIdSchema } from './engagement.schemas.js';
import { InboxService } from './inbox.service.js';

const ALL = ['ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER'] as const;

/** The bell: the signed-in person's own alerts, nobody else's. */
@Controller('notifications')
export class InboxController {
    constructor(private readonly inbox: InboxService) {}

    /** The latest alerts and how many are unread. The app asks again every minute. */
    @Roles(...ALL)
    @Get()
    list(@CurrentUser() auth: AuthContext) {
        return this.inbox.list(auth);
    }

    @Roles(...ALL)
    @Post('read-all')
    @HttpCode(200)
    @RateLimit({ limit: 60, windowSeconds: 60 })
    async readAll(@CurrentUser() auth: AuthContext) {
        await this.inbox.markAllRead(auth);
        return { ok: true };
    }

    @Roles(...ALL)
    @Post(':id/read')
    @HttpCode(200)
    @RateLimit({ limit: 120, windowSeconds: 60 })
    async read(@CurrentUser() auth: AuthContext, @Param('id', { schema: notificationIdSchema }) id: string) {
        await this.inbox.markRead(auth, BigInt(id));
        return { ok: true };
    }
}
