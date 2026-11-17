import { Body, Controller, HttpCode, Ip, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { leadIdSchema } from '@modules/leads';
import { PrivacyService } from './privacy.service.js';

const anonymiseSchema = z.strictObject({
    reason: z.string('Say why').trim().min(5, 'Say why, in at least a few words').max(300, 'Keep the reason under 300 characters'),
});
type AnonymiseBody = z.infer<typeof anonymiseSchema>;

@Roles('ADMIN')
@Controller('leads')
export class PrivacyController {
    constructor(private readonly privacy: PrivacyService) {}

    /**
     * Erases the lead's personal details for good (name, phone, email, notes, form answers). The history stays as
     * counts and dates. It cannot be undone. The lead stops opening afterwards, so the answer is just `{ id, anonymised: true }`.
     */
    @Post(':id/anonymise')
    @HttpCode(200)
    @RateLimit({ limit: 10, windowSeconds: 60 })
    anonymise(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: anonymiseSchema }) body: AnonymiseBody,
        @Ip() ip: string,
    ) {
        return this.privacy.anonymise(auth, id, body.reason, { ip });
    }
}
