import { Test } from '@nestjs/testing';
import { NOTIFICATION_EXECUTORS } from '../notification.executor.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { NotificationsProcessor } from './notifications.processor.js';
import { NotificationsProcessorModule } from './notifications-processor.module.js';

describe('NotificationsProcessorModule', () => {
    beforeEach(() => {
        process.env.AWS_REGION = 'ap-south-1';
        process.env.EMAIL_FROM = 'CRM <crm@interviewcall.club>';
    });
    afterEach(() => {
        delete process.env.AWS_REGION;
        delete process.env.EMAIL_FROM;
    });

    it('wires the email executor into the dispatcher and the processor', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [NotificationsProcessorModule],
        }).compile();

        const executors = moduleRef.get<{ channel: string }[]>(
            NOTIFICATION_EXECUTORS,
        );
        expect(executors.map((executor) => executor.channel)).toEqual([
            'EMAIL',
        ]);
        expect(moduleRef.get(NotificationDispatcher)).toBeDefined();
        expect(moduleRef.get(NotificationsProcessor)).toBeDefined();
    });

    it('hands each queued job to the dispatcher', async () => {
        const dispatch = vi.fn().mockResolvedValue(undefined);
        const processor = new NotificationsProcessor({
            dispatch,
        } as unknown as NotificationDispatcher);
        const data = { channel: 'EMAIL' };

        await processor.process({ data } as never);

        expect(dispatch).toHaveBeenCalledWith(data);
    });

    it('refuses to start the worker without email settings', async () => {
        delete process.env.EMAIL_FROM;

        await expect(
            Test.createTestingModule({
                imports: [NotificationsProcessorModule],
            }).compile(),
        ).rejects.toThrow(/EMAIL_FROM/);
    });
});
