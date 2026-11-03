import type { Queue } from 'bullmq';
import { NotificationService } from './notification.service.js';
import type { NotificationMessage } from './notification.types.js';

describe('NotificationService', () => {
    const message: NotificationMessage<'staff-invite'> = {
        channel: 'EMAIL',
        recipient: 'ravi@example.com',
        template: 'staff-invite',
        data: {
            name: 'Ravi',
            role: 'Closer',
            email: 'ravi@example.com',
            temporaryPassword: 'abc',
            loginUrl: 'http://localhost:3002/login',
        },
    };

    function build(ready: Promise<void>) {
        const add = vi.fn().mockResolvedValue({});
        const queue = {
            waitUntilReady: () => ready,
            add,
        } as unknown as Queue<NotificationMessage>;
        return { service: new NotificationService(queue), add };
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('queues the message with retries, and does not keep finished jobs', async () => {
        const { service, add } = build(Promise.resolve());

        await service.enqueue(message);

        expect(add).toHaveBeenCalledWith('send', message, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: true,
            removeOnFail: { age: 86_400 },
        });
    });

    it('gives up after two seconds when Redis is not reachable, without queuing anything', async () => {
        vi.useFakeTimers();
        const { service, add } = build(new Promise<void>(() => undefined));

        const result = expect(service.enqueue(message)).rejects.toThrow(
            'not connected',
        );
        await vi.advanceTimersByTimeAsync(2_000);

        await result;
        expect(add).not.toHaveBeenCalled();
    });

    it('passes a queue error on to the caller', async () => {
        const { service, add } = build(Promise.resolve());
        add.mockRejectedValue(new Error('OOM command not allowed'));

        await expect(service.enqueue(message)).rejects.toThrow('OOM');
    });
});
