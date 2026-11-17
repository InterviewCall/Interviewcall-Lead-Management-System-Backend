import { Body, Controller, Get, HttpCode, Ip, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { LeadsService, leadIdSchema } from '@modules/leads';
import { MergeService } from './merge.service.js';

const mergeSchema = z.strictObject({ duplicateId: z.uuid('Choose the duplicate lead') }, 'Send a JSON body with duplicateId');
type MergeBody = z.infer<typeof mergeSchema>;

/** Finding and merging duplicate leads. Managers and admins. */
@Roles('ADMIN', 'SALES_MANAGER')
@Controller('leads')
export class MergeController {
    constructor(
        private readonly merge: MergeService,
        private readonly leads: LeadsService,
    ) {}

    /** Leads with the same name as this one: likely duplicates to review. */
    @Get(':id/duplicates')
    duplicates(@CurrentUser() auth: AuthContext, @Param('id', { schema: leadIdSchema }) id: string) {
        return this.leads.possibleDuplicates(auth, id);
    }

    /** Merges `duplicateId` into this lead, which is kept. Returns the kept lead, like GET /leads/:id. */
    @Post(':id/merge')
    @HttpCode(200)
    @RateLimit({ limit: 20, windowSeconds: 60 })
    mergeInto(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: mergeSchema }) body: MergeBody,
        @Ip() ip: string | undefined,
    ) {
        return this.merge.merge(auth, id, body.duplicateId, { ip });
    }
}
