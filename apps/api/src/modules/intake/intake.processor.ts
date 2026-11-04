import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Job } from 'bullmq';
import { INTAKE_QUEUE, SWEEP_EVERY_MS } from './intake.constants.js';
import type { IntakeQueueMessage } from './intake.queue.js';
import { IntakeService } from './intake.service.js';

/** Runs in the worker process: turns one stored event into its effect. */
@Processor(INTAKE_QUEUE, { concurrency: 4 })
export class IntakeProcessor extends WorkerHost {
    constructor(private readonly intake: IntakeService) {
        super();
    }

    async process(job: Job<IntakeQueueMessage>): Promise<void> {
        // process() records its own outcome on the event and does not throw.
        await this.intake.process(BigInt(job.data.inboxId));
    }
}

/**
 * Every minute, looks for events nobody is handling and queues them: the safety net for a queue
 * that was down when an event came, a worker that died mid-event, and failed events whose wait is over.
 */
@Injectable()
export class IntakeSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(IntakeSweeper.name);
    private timer?: NodeJS.Timeout;

    constructor(private readonly intake: IntakeService) {}

    onApplicationBootstrap(): void {
        const run = async () => {
            try {
                const queued = await this.intake.sweep();
                if (queued > 0) this.logger.log(`Queued ${queued} event(s) nobody was handling`);
            } catch (error) {
                this.logger.error(`Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        void run();
        this.timer = setInterval(() => void run(), SWEEP_EVERY_MS);
        this.timer.unref();
    }

    onApplicationShutdown(): void {
        clearInterval(this.timer);
    }
}
