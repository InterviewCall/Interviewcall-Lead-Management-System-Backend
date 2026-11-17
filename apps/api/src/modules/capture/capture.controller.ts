import { Body, Controller, Ip, Post } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type CreateLeadBody, createLeadSchema } from '@modules/leads';
import { CaptureService } from './capture.service.js';

/** Adding one lead by hand. Answers 409 LEAD_EXISTS, naming the lead, when the person is already here. */
@Roles('ADMIN', 'SALES_MANAGER', 'BDA')
@Controller('leads')
export class CaptureController {
    constructor(private readonly capture: CaptureService) {}

    @Post()
    @RateLimit({ limit: 30, windowSeconds: 60 })
    create(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: createLeadSchema }) body: CreateLeadBody,
        @Ip() ip: string | undefined,
    ): Promise<{ id: string }> {
        return this.capture.create(auth, body, { ip });
    }
}
