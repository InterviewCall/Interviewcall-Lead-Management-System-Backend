import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service.js';
import { NOTIFICATIONS_QUEUE } from './notifications.constants.js';

/**
 * The producing side: lets any module queue a notification. Importing it does not start any
 * processing; that is NotificationsProcessorModule, imported by the worker only.
 */
@Module({
    imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
    providers: [NotificationService],
    exports: [NotificationService],
})
export class NotificationsModule {}
