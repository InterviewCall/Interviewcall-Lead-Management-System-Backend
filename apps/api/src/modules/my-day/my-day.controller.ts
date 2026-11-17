import { Controller, Get, Query } from '@nestjs/common';
import { type AuthContext, CurrentUser, Roles } from '@app/rbac';
import { MyDayService } from './my-day.service.js';

@Controller('my-day')
export class MyDayController {
    constructor(private readonly myDay: MyDayService) {}

    /** What the signed-in person has to do today. Managers also see the team's booked calls and numbers. */
    @Roles('ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER')
    @Get()
    get(@CurrentUser() auth: AuthContext, @Query('view') view?: string) {
        return this.myDay.get(auth, view === 'team' ? 'team' : 'mine');
    }
}
