import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { NotificationExecutor } from '../notification.executor.js';
import type { NotificationMessage } from '../notification.types.js';
import { EMAIL_CONFIG, type EmailConfig } from './email.config.js';
import { TemplateRenderer } from './template.renderer.js';

export const SES_CLIENT = Symbol('SES_CLIENT');

/** SES answers like these will not change on a retry: the message or the account is the problem. */
const PERMANENT_SES_ERRORS = new Set([
    'MessageRejected',
    'AccountSuspendedException',
    'SendingPausedException',
    'MailFromDomainNotVerifiedException',
]);

/** The email strategy: renders the template with Handlebars and sends it through Amazon SES. */
@Injectable()
export class EmailExecutor implements NotificationExecutor {
    readonly channel = 'EMAIL' as const;
    private readonly logger = new Logger(EmailExecutor.name);

    constructor(
        @Inject(SES_CLIENT) private readonly ses: SESv2Client,
        @Inject(EMAIL_CONFIG) private readonly config: EmailConfig,
        private readonly renderer: TemplateRenderer,
    ) {}

    async send(message: NotificationMessage): Promise<void> {
        const email = this.renderer.render(message);

        try {
            await this.ses.send(
                new SendEmailCommand({
                    FromEmailAddress: this.config.from,
                    // Replies go here instead of the sender, if set (EMAIL_REPLY_TO).
                    ...(this.config.replyTo.length > 0
                        ? { ReplyToAddresses: this.config.replyTo }
                        : {}),
                    Destination: { ToAddresses: [message.recipient] },
                    Content: {
                        Simple: {
                            Subject: { Data: email.subject, Charset: 'UTF-8' },
                            Body: {
                                Html: { Data: email.html, Charset: 'UTF-8' },
                                Text: { Data: email.text, Charset: 'UTF-8' },
                            },
                        },
                    },
                    ...(this.config.configurationSet
                        ? { ConfigurationSetName: this.config.configurationSet }
                        : {}),
                }),
            );
        } catch (error) {
            const name = error instanceof Error ? error.name : 'UnknownError';
            // The recipient and body are left out of the log on purpose.
            this.logger.warn(
                `SES refused a "${message.template}" email: ${name}`,
            );
            if (PERMANENT_SES_ERRORS.has(name)) {
                throw new UnrecoverableError(`SES rejected the email: ${name}`);
            }
            throw error;
        }
    }
}
