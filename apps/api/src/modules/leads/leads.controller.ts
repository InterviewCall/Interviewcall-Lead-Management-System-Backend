import { Body, Controller, Get, Header, HttpCode, Ip, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import {
    type BulkContactStageBody,
    bulkContactStageSchema,
    type ContactStageBody,
    type CustomValuesBody,
    customValuesSchema,
    contactStageSchema,
    type EditLeadBody,
    editLeadSchema,
    type ExportLeadsQuery,
    exportLeadsQuerySchema,
    type ListLeadsQuery,
    leadIdSchema,
    listLeadsQuerySchema,
    type SuppressionCheckBody,
    suppressionCheckSchema,
} from './leads.schemas.js';
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

    /**
     * The same leads as the list, for the same filters, as a CSV download (managers and admins; at most 5,000 rows).
     * Each export is recorded in the audit log.
     */
    @Get('export')
    @Roles('ADMIN', 'SALES_MANAGER')
    @RateLimit({ limit: 6, windowSeconds: 60 })
    @Header('Cache-Control', 'no-store')
    async export(
        @CurrentUser() auth: AuthContext,
        @Query({ schema: exportLeadsQuerySchema }) query: ExportLeadsQuery,
        @Ip() ip: string,
        @Res({ passthrough: true }) res: { header(name: string, value: string): unknown },
    ) {
        const { filename, csv } = await this.leads.exportLeads(auth, query, { ip });
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.header('Content-Disposition', `attachment; filename="${filename}"`);
        return csv;
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

    /**
     * Marks the contact stage of many leads at once (the bulk bar on the leads list), with the same rules as one lead.
     * Answers how many changed, how many were already there, and why any were left alone.
     */
    @Post('contact-stage/bulk')
    @HttpCode(200)
    @RateLimit({ limit: 20, windowSeconds: 60 })
    bulkContactStage(
        @CurrentUser() auth: AuthContext,
        @Body({ schema: bulkContactStageSchema }) body: BulkContactStageBody,
    ) {
        return this.leads.bulkSetContactStage(auth, body.leadIds, body.stage);
    }

    /** Which of these phones and emails must not be messaged. Used before a campaign or a bulk send. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Post('suppression/check')
    @HttpCode(200)
    @RateLimit({ limit: 30, windowSeconds: 60 })
    checkSuppression(@Body({ schema: suppressionCheckSchema }) body: SuppressionCheckBody) {
        return this.leads.checkSuppression(body.phones, body.emails);
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

    /**
     * Changes the lead's details (name, phone, email, company, CTC, graduation year, domain). Only the fields sent
     * change. Answers 409 LEAD_EXISTS when the new email or phone belongs to another lead. Returns the refreshed lead.
     */
    @Patch(':id')
    @RateLimit({ limit: 60, windowSeconds: 60 })
    edit(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: editLeadSchema }) body: EditLeadBody,
        @Ip() ip: string,
    ) {
        return this.leads.editLead(auth, id, body, { ip });
    }

    /** Sets or clears values of the custom fields on this lead. Returns the refreshed lead. */
    @Patch(':id/custom')
    @RateLimit({ limit: 60, windowSeconds: 60 })
    setCustom(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: leadIdSchema }) id: string,
        @Body({ schema: customValuesSchema }) body: CustomValuesBody,
        @Ip() ip: string,
    ) {
        return this.leads.setCustomValues(auth, id, body.values, { ip });
    }
}
