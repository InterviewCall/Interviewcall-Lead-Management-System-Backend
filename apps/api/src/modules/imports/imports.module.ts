import { Module } from '@nestjs/common';
import { LeadsModule } from '@modules/leads';
import { TimelineModule } from '@modules/timeline';
import { AdminModule } from '@modules/admin';
import { ImportsRepository } from './imports.repository.js';
import { ImportsService } from './imports.service.js';

/**
 * CSV upload, column mapping, dry run and commit.
 */
@Module({
    imports: [LeadsModule, TimelineModule, AdminModule],
    providers: [ImportsRepository, ImportsService],
    exports: [ImportsService],
})
export class ImportsModule {}
