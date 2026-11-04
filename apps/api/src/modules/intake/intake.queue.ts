import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { INTAKE_QUEUE } from './intake.constants.js';

export interface IntakeQueueMessage {
    /** The inbox event's id. */
    inboxId: string;
}

const CONNECT_TIMEOUT_MS = 2_000;

/** Hands an event to the worker. Failing to queue is not failing to receive: the sweeper picks the event up. */
@Injectable()
export class IntakeQueue {
    private readonly logger = new Logger(IntakeQueue.name);

    constructor(@InjectQueue(INTAKE_QUEUE) private readonly queue: Queue<IntakeQueueMessage>) {}

    /** Never throws. Returns whether the event is now in the queue. */
    async enqueue(inboxId: bigint, delayMs = 0): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        try {
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Intake queue is not connected')), CONNECT_TIMEOUT_MS);
            });
            await Promise.race([this.queue.waitUntilReady(), timeout]);
            await this.queue.add(
                'process',
                { inboxId: String(inboxId) },
                { delay: delayMs, attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
            );
            return true;
        } catch (error) {
            this.logger.warn(`Could not queue inbox event ${inboxId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}
