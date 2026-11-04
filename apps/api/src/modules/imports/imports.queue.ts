import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { IMPORTS_QUEUE } from './imports.constants.js';

export interface ImportQueueMessage {
    /** The import's public id. */
    importId: string;
}

/** How long a request waits for Redis before it gives up and reports the queue as unavailable. */
const CONNECT_TIMEOUT_MS = 2_000;

/** The producing side: queues an import for the worker. Importing it starts no processing. */
@Injectable()
export class ImportsQueue {
    constructor(
        @InjectQueue(IMPORTS_QUEUE)
        private readonly queue: Queue<ImportQueueMessage>,
    ) {}

    /** Throws if the import could not be queued, so the caller can undo what it just did. */
    async enqueue(importId: string): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('Import queue is not connected')),
                CONNECT_TIMEOUT_MS,
            );
        });
        try {
            await Promise.race([this.queue.waitUntilReady(), timeout]);
        } finally {
            clearTimeout(timer);
        }
        await this.queue.add(
            'process',
            { importId },
            {
                // A stopped worker or a database blip resumes where it left off: rows already done are not redone.
                attempts: 3,
                backoff: { type: 'exponential', delay: 15_000 },
                removeOnComplete: true,
                removeOnFail: { age: 7 * 24 * 60 * 60 },
            },
        );
    }
}
