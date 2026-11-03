import type {
    NotificationChannel,
    NotificationMessage,
} from './notification.types.js';

/**
 * Strategy interface: one implementation per channel (email now, WhatsApp and SMS later).
 * `send` resolves when the provider has accepted the message and throws when it has not, so the
 * queue can retry. Throw BullMQ's UnrecoverableError for a failure that retrying cannot fix.
 */
export interface NotificationExecutor {
    readonly channel: NotificationChannel;
    send(message: NotificationMessage): Promise<void>;
}

/** Injection token for the list of every registered executor. */
export const NOTIFICATION_EXECUTORS = Symbol('NOTIFICATION_EXECUTORS');
