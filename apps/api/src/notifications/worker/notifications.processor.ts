import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { NotificationMessage } from '../notification.types.js';
import { NOTIFICATIONS_QUEUE } from '../notifications.constants.js';
import { NotificationDispatcher } from './notification.dispatcher.js';

/** Runs in the worker process: takes queued notifications and delivers them. */
@Processor(NOTIFICATIONS_QUEUE, { concurrency: 5 })
export class NotificationsProcessor extends WorkerHost {
    constructor(private readonly dispatcher: NotificationDispatcher) {
        super();
    }

    async process(job: Job<NotificationMessage>): Promise<void> {
        await this.dispatcher.dispatch(job.data);
    }
}
