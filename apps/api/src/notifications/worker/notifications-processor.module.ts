import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Module } from '@nestjs/common';
import { NOTIFICATION_EXECUTORS } from '../notification.executor.js';
import {
    EMAIL_CONFIG,
    type EmailConfig,
    loadEmailConfig,
} from './email.config.js';
import { EmailExecutor, SES_CLIENT } from './email.executor.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationsProcessor } from './notifications.processor.js';
import { TemplateRenderer } from './template.renderer.js';

/**
 * The consuming side. Imported by the worker only, so the API process never sends anything itself.
 *
 * To add a channel (WhatsApp, SMS): write a class that implements NotificationExecutor, add it to
 * `providers`, and add it to the NOTIFICATION_EXECUTORS list below. Nothing else changes.
 */
@Module({
    providers: [
        { provide: EMAIL_CONFIG, useFactory: () => loadEmailConfig() },
        {
            provide: SES_CLIENT,
            inject: [EMAIL_CONFIG],
            useFactory: (config: EmailConfig) =>
                new SESv2Client({ region: config.region }),
        },
        TemplateRenderer,
        EmailExecutor,
        {
            provide: NOTIFICATION_EXECUTORS,
            inject: [EmailExecutor],
            useFactory: (email: EmailExecutor) => [email],
        },
        NotificationDispatcher,
        NotificationsProcessor,
    ],
})
export class NotificationsProcessorModule {}
