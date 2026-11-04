import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { IMPORTS_QUEUE } from './imports.constants.js';
import type { ImportQueueMessage } from './imports.queue.js';
import { ImportsService } from './imports.service.js';

/**
 * Runs in the worker process: takes a queued import and runs it. One at a time, so one big file
 * cannot starve the database.
 */
@Processor(IMPORTS_QUEUE, { concurrency: 1 })
export class ImportsProcessor extends WorkerHost {
    constructor(private readonly imports: ImportsService) {
        super();
    }

    async process(job: Job<ImportQueueMessage>): Promise<void> {
        try {
            await this.imports.process(job.data.importId);
        } catch (error) {
            // BullMQ retries with a delay, and a retry resumes where this one stopped. After the
            // last attempt the import is marked failed so the person sees it and can restart it.
            const attempts = job.opts.attempts ?? 1;
            if (job.attemptsMade + 1 >= attempts) {
                await this.imports.markFailed(
                    job.data.importId,
                    'The import stopped before it finished. Leads already imported are kept; start it again to continue.',
                );
            }
            throw error;
        }
    }
}
