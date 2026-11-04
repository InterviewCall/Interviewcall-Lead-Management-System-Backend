import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { type ContactStageBody, contactStageSchema, type ListLeadsQuery, leadIdSchema, listLeadsQuerySchema } from './leads.schemas.js';
import { LeadsService } from './leads.service.js';

/**
 * Reading leads. What a person sees depends on their role (see LeadsService): a BDA their own
 * leads, a closer the leads in play, everyone else every lead.
 */
@Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
@Controller('leads')
export class LeadsController {
    constructor(private readonly leads: LeadsService) {}

    @Get()
    list(
        @CurrentUser() auth: AuthContext,
        @Query({ schema: listLeadsQuerySchema }) query: ListLeadsQuery,
    ) {
        return this.leads.listLeads(auth, query);
    }

    /** Sources, owners and lists for the filters. */
    @Get('filters')
    filters(@CurrentUser() auth: AuthContext) {
        return this.leads.leadFilters(auth);
    }

    @Get(':id')
    get(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
    ) {
        return this.leads.getLead(auth, id);
    }

    /** Marks the contact stage. Returns the refreshed lead, like GET /leads/:id. */
    @Post(':id/contact-stage')
    @HttpCode(200)
    @RateLimit({ limit: 60, windowSeconds: 60 })
    setContactStage(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: contactStageSchema }) body: ContactStageBody,
    ) {
        return this.leads.setContactStage(auth, id, body.stage);
    }
}
