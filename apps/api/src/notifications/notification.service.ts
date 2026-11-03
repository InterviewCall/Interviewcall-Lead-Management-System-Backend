import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { NOTIFICATIONS_QUEUE } from './notifications.constants.js';
import type {
    NotificationMessage,
    TemplateName,
} from './notification.types.js';

/** How long a request waits for Redis before it gives up and reports the queue as unavailable. */
const CONNECT_TIMEOUT_MS = 2_000;

/**
 * What the rest of the app calls to send something. It only queues the message; the worker
 * process picks it up and hands it to the executor for its channel.
 */
@Injectable()
export class NotificationService {
    constructor(
        @InjectQueue(NOTIFICATIONS_QUEUE)
        private readonly queue: Queue<NotificationMessage>,
    ) {}

    /** Throws if the message could not be queued, so the caller can undo what it just did. */
    async enqueue<T extends TemplateName>(
        message: NotificationMessage<T>,
    ): Promise<void> {
        // Fail fast if Redis is down, rather than leaving the request waiting on a queue that may never drain.
        await this.connected();

        await this.queue.add('send', message, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 10_000 },
            // Messages can carry one-time secrets: keep them in Redis only as long as needed.
            removeOnComplete: true,
            removeOnFail: { age: 24 * 60 * 60 },
        });
    }

    private async connected(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('Notification queue is not connected')),
                CONNECT_TIMEOUT_MS,
            );
        });
        try {
            await Promise.race([this.queue.waitUntilReady(), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }
}
