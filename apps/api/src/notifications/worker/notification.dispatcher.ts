import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import {
    NOTIFICATION_EXECUTORS,
    type NotificationExecutor,
} from '../notification.executor.js';
import type {
    NotificationChannel,
    NotificationMessage,
} from '../notification.types.js';

/**
 * The strategy context: picks the executor registered for the message's channel and lets it send.
 * It does not know how any channel works, so a new channel needs no change here.
 */
@Injectable()
export class NotificationDispatcher {
    private readonly executors: Map<NotificationChannel, NotificationExecutor>;

    constructor(
        @Inject(NOTIFICATION_EXECUTORS) executors: NotificationExecutor[],
    ) {
        this.executors = new Map(
            executors.map((executor) => [executor.channel, executor]),
        );
    }

    async dispatch(message: NotificationMessage): Promise<void> {
        const executor = this.executors.get(message.channel);
        if (!executor) {
            // Retrying cannot create a missing executor.
            throw new UnrecoverableError(
                `No executor is registered for channel ${message.channel}`,
            );
        }
        await executor.send(message);
    }
}
