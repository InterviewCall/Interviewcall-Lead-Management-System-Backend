import { Module } from '@nestjs/common';
import { AssignmentModule } from '@modules/assignment';
import { EngagementModule } from '@modules/engagement';
import { IamModule } from '@modules/iam';
import { LeadsModule } from '@modules/leads';
import { MyDayController } from './my-day.controller.js';
import { MyDayService } from './my-day.service.js';

/** The My day screen. It only reads, through the other modules' services. */
@Module({
    imports: [EngagementModule, LeadsModule, AssignmentModule, IamModule],
    controllers: [MyDayController],
    providers: [MyDayService],
})
export class MyDayModule {}
