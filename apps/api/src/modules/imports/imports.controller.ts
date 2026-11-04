import { FileInterceptor } from '@nestjs/platform-express';
import {
    Body,
    Controller,
    Get,
    HttpCode,
    Ip,
    Param,
    Post,
    Put,
    Query,
    Res,
    StreamableFile,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { RateLimit } from '@app/rate-limit';
import { CSV_LIMITS } from './csv/csv-parser.js';
import {
    type ConfigureImportBody,
    configureImportSchema,
    importIdSchema,
    type ListImportsQuery,
    listImportsQuerySchema,
    type ListRowsQuery,
    listRowsQuerySchema,
} from './imports.schemas.js';
import { ImportsService, type UploadedCsv } from './imports.service.js';

/** Starting, uploading and cancelling imports: a handful a minute is plenty for a person. */
const IMPORT_WRITES = { limit: 20, windowSeconds: 60 } as const;
const IMPORT_UPLOADS = { limit: 10, windowSeconds: 60 } as const;

/**
 * Manual CSV import. Only admins and sales managers: every route here, including reading the
 * history, is closed to the other roles.
 */
@Roles('ADMIN', 'SALES_MANAGER')
@Controller('imports')
export class ImportsController {
    constructor(private readonly imports: ImportsService) {}

    /** Lead sources, possible owners, mappable fields and limits, for the import form. */
    @Get('options')
    options(@CurrentUser() auth: AuthContext) {
        return this.imports.options(auth);
    }

    /** Past and running imports, newest first. */
    @Get()
    list(
        @CurrentUser() auth: AuthContext,
        @Query({ schema: listImportsQuerySchema }) query: ListImportsQuery,
    ) {
        return this.imports.list(auth, query);
    }

    /** Step 1. Send the CSV as multipart form data in the `file` field. */
    @Post()
    @HttpCode(201)
    @RateLimit(IMPORT_UPLOADS)
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: CSV_LIMITS.maxFileBytes, files: 1, fields: 0 },
        }),
    )
    upload(
        @CurrentUser() auth: AuthContext,
        @UploadedFile() file: UploadedCsv | undefined,
        @Ip() ip: string | undefined,
    ) {
        return this.imports.createFromUpload(auth, file, { ip });
    }

    @Get(':id')
    get(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
    ) {
        return this.imports.get(auth, id);
    }

    /** Step 2. Column mapping, list name, source, owner and duplicate handling. */
    @Put(':id/configuration')
    @RateLimit(IMPORT_WRITES)
    configure(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
        @Body({ schema: configureImportSchema }) body: ConfigureImportBody,
    ) {
        return this.imports.configure(auth, id, body);
    }

    /** Step 3. What would happen to every row. Writes nothing. */
    @Post(':id/dry-run')
    @HttpCode(200)
    @RateLimit(IMPORT_WRITES)
    dryRun(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
    ) {
        return this.imports.dryRun(auth, id);
    }

    /** Step 4. Queues the import; poll GET /imports/:id for progress. */
    @Post(':id/start')
    @HttpCode(202)
    @RateLimit(IMPORT_WRITES)
    start(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
        @Ip() ip: string | undefined,
    ) {
        return this.imports.start(auth, id, { ip });
    }

    @Post(':id/cancel')
    @HttpCode(200)
    @RateLimit(IMPORT_WRITES)
    cancel(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
        @Ip() ip: string | undefined,
    ) {
        return this.imports.cancel(auth, id, { ip });
    }

    /** The rows of an import and what happened to each; filter with ?status=ERROR. */
    @Get(':id/rows')
    rows(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
        @Query({ schema: listRowsQuerySchema }) query: ListRowsQuery,
    ) {
        return this.imports.rows(auth, id, query);
    }

    /** The original file plus ImportStatus and ImportMessage columns, as a CSV download. */
    @Get(':id/report')
    @RateLimit(IMPORT_WRITES)
    async report(
        @CurrentUser() auth: AuthContext,
        @Param('id', { schema: importIdSchema }) id: string,
        @Ip() ip: string | undefined,
        @Res({ passthrough: true }) response: Response,
    ): Promise<StreamableFile> {
        const { fileName, csv } = await this.imports.report(auth, id, { ip });
        response.set({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Cache-Control': 'no-store',
        });
        return new StreamableFile(Buffer.from(csv, 'utf8'));
    }
}
