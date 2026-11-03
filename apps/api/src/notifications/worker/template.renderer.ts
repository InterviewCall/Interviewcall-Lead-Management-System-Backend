import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import Handlebars from 'handlebars';
import type { NotificationMessage } from '../notification.types.js';
import { EMAIL_TEMPLATES } from './templates/index.js';

export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
}

type Compiled = Record<keyof RenderedEmail, HandlebarsTemplateDelegate>;

@Injectable()
export class TemplateRenderer {
    // A private Handlebars environment, so nothing registered elsewhere can leak in.
    private readonly handlebars = Handlebars.create();
    private readonly compiled = new Map<string, Compiled>();

    render(
        message: Pick<NotificationMessage, 'template' | 'data'>,
    ): RenderedEmail {
        const compiled = this.compile(message.template);
        return {
            subject: compiled.subject(message.data).trim(),
            html: compiled.html(message.data),
            text: compiled.text(message.data),
        };
    }

    private compile(template: string): Compiled {
        const cached = this.compiled.get(template);
        if (cached) {
            return cached;
        }

        const source = (
            EMAIL_TEMPLATES as Record<
                string,
                (typeof EMAIL_TEMPLATES)[keyof typeof EMAIL_TEMPLATES]
            >
        )[template];
        if (!source) {
            // A missing template is a code bug: retrying cannot fix it.
            throw new UnrecoverableError(
                `No email template named "${template}"`,
            );
        }

        const compiled: Compiled = {
            subject: this.handlebars.compile(source.subject, {
                noEscape: true,
                strict: true,
            }),
            text: this.handlebars.compile(source.text, {
                noEscape: true,
                strict: true,
            }),
            // HTML keeps Handlebars' default escaping.
            html: this.handlebars.compile(source.html, { strict: true }),
        };
        this.compiled.set(template, compiled);
        return compiled;
    }
}
