/** Every way a notification can leave the CRM. Each channel has one NotificationExecutor. */
export type NotificationChannel = 'EMAIL' | 'WHATSAPP' | 'SMS';

/**
 * The data each template needs, by template name. Adding a template means adding it here, so
 * callers cannot forget a field and channels cannot render the wrong data.
 */
export interface NotificationTemplates {
    'staff-invite': {
        name: string;
        /** Display name of the role, e.g. "Sales Manager". */
        role: string;
        email: string;
        temporaryPassword: string;
        loginUrl: string;
    };
}

export type TemplateName = keyof NotificationTemplates;

/**
 * One notification to deliver. It says what to send (a template and its data) and to whom, never
 * how to word or format it: each channel's executor does that for itself.
 */
export interface NotificationMessage<T extends TemplateName = TemplateName> {
    channel: NotificationChannel;
    /** An email address, or a phone number for the phone channels. */
    recipient: string;
    template: T;
    data: NotificationTemplates[T];
}
