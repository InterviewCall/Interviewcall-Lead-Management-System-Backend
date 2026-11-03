import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { EmailExecutor } from './email.executor.js';
import type { EmailConfig } from './email.config.js';
import type { NotificationMessage } from '../notification.types.js';
import { TemplateRenderer } from './template.renderer.js';

const message: NotificationMessage = {
    channel: 'EMAIL',
    recipient: 'ravi@example.com',
    template: 'staff-invite',
    data: {
        name: 'Ravi Kumar',
        role: 'Closer',
        email: 'ravi@example.com',
        temporaryPassword: 'Xk4mN8qRt2WpZ9',
        loginUrl: 'https://crm.interviewcall.club/login',
    },
};

describe('EmailExecutor', () => {
    const send = vi.fn();
    const config: EmailConfig = {
        region: 'ap-south-1',
        from: 'InterviewCall CRM <crm@interviewcall.club>',
        replyTo: [],
        configurationSet: undefined,
    };
    const build = (overrides: Partial<EmailConfig> = {}) =>
        new EmailExecutor(
            { send } as unknown as SESv2Client,
            { ...config, ...overrides },
            new TemplateRenderer(),
        );

    beforeEach(() => {
        send.mockReset();
        send.mockResolvedValue({});
    });

    it('is the strategy for the EMAIL channel', () => {
        expect(build().channel).toBe('EMAIL');
    });

    it('sends the rendered invite through SES from the configured sender', async () => {
        await build().send(message);

        const { input } = send.mock.calls[0][0];
        expect(input.FromEmailAddress).toBe(
            'InterviewCall CRM <crm@interviewcall.club>',
        );
        expect(input.Destination).toEqual({
            ToAddresses: ['ravi@example.com'],
        });
        expect(input.Content.Simple.Subject.Data).toBe(
            'Your InterviewCall CRM account',
        );
        expect(input.Content.Simple.Body.Html.Data).toContain('Xk4mN8qRt2WpZ9');
        expect(input.Content.Simple.Body.Text.Data).toContain('Xk4mN8qRt2WpZ9');
        expect(input.ConfigurationSetName).toBeUndefined();
    });

    it('sends no reply-to when none is configured, so replies go to the sender', async () => {
        await build().send(message);

        expect(send.mock.calls[0][0].input).not.toHaveProperty(
            'ReplyToAddresses',
        );
    });

    it('sets the reply-to addresses when configured', async () => {
        await build({
            replyTo: [
                'Support <support@interviewcall.club>',
                'ops@interviewcall.club',
            ],
        }).send(message);

        expect(send.mock.calls[0][0].input.ReplyToAddresses).toEqual([
            'Support <support@interviewcall.club>',
            'ops@interviewcall.club',
        ]);
    });

    it('adds the SES configuration set when one is configured', async () => {
        await build({ configurationSet: 'crm-transactional' }).send(message);

        expect(send.mock.calls[0][0].input.ConfigurationSetName).toBe(
            'crm-transactional',
        );
    });

    it('does not retry when SES rejects the message itself', async () => {
        send.mockRejectedValue(
            Object.assign(new Error('Email address is not verified'), {
                name: 'MessageRejected',
            }),
        );

        await expect(build().send(message)).rejects.toMatchObject({
            name: 'UnrecoverableError',
        });
    });

    it('lets other SES errors through so the queue retries them', async () => {
        const throttled = Object.assign(new Error('Slow down'), {
            name: 'TooManyRequestsException',
        });
        send.mockRejectedValue(throttled);

        await expect(build().send(message)).rejects.toBe(throttled);
    });

    it('fails before calling SES when the template is unknown', async () => {
        await expect(
            build().send({ ...message, template: 'nope' as 'staff-invite' }),
        ).rejects.toMatchObject({ name: 'UnrecoverableError' });
        expect(send).not.toHaveBeenCalled();
    });
});
