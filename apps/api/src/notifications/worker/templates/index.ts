import type { TemplateName } from '../../notification.types.js';
import type { EmailTemplate } from './email-template.js';
import staffInviteHtml from './staff-invite/html.hbs';
import staffInviteSubject from './staff-invite/subject.hbs';
import staffInviteText from './staff-invite/text.hbs';

/**
 * Every email template, by name. Each one is a folder of three Handlebars files: subject.hbs,
 * text.hbs and html.hbs. The build inlines them into the bundle, so there is no file path to get
 * wrong in production.
 * Not every template needs an email version: a template meant only for WhatsApp is simply absent.
 */
export const EMAIL_TEMPLATES: Partial<Record<TemplateName, EmailTemplate>> = {
    'staff-invite': {
        subject: staffInviteSubject,
        text: staffInviteText,
        html: staffInviteHtml,
    },
};
