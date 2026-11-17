import { Module } from '@nestjs/common';
import { TimelineModule } from '@modules/timeline';
import { AdminModule } from '@modules/admin';
import { IamModule } from '@modules/iam';
import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { LeadsController } from './leads.controller.js';
import { LeadsRepository } from './leads.repository.js';
import { LeadsService } from './leads.service.js';
import { SavedViewsController } from './saved-views.controller.js';
import { SavedViewsService } from './saved-views.service.js';
import { ScoresController } from './scores.controller.js';
import { ScoringService } from './scoring.service.js';
import { SourcesController } from './sources.controller.js';
import { SourcesService } from './sources.service.js';

/**
 * The lead record and its score: matching, merging, sources, touchpoints, VSL answers, bookings, custom fields, saved views, do-not-contact, anonymise and export.
 */
@Module({
    imports: [TimelineModule, AdminModule, IamModule],
    controllers: [LeadsController, SourcesController, ScoresController, SavedViewsController, CustomFieldsController],
    providers: [LeadsRepository, LeadsService, SourcesService, ScoringService, SavedViewsService, CustomFieldsService],
    exports: [LeadsService],
})
export class LeadsModule {}
