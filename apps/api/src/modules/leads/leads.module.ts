import { Module } from '@nestjs/common';
import { TimelineModule } from '@modules/timeline';
import { AdminModule } from '@modules/admin';
import { LeadsRepository } from './leads.repository.js';
import { LeadsService } from './leads.service.js';

/**
 * The lead record: matching, merging, sources, touchpoints, VSL answers, bookings, custom fields, saved views, do-not-contact, anonymise and export.
 */
@Module({
    imports: [TimelineModule, AdminModule],
    providers: [LeadsRepository, LeadsService],
    exports: [LeadsService],
})
export class LeadsModule {}
