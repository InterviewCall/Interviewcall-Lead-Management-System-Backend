import { NotificationDispatcher } from './notification.dispatcher.js';
import type { NotificationExecutor } from '../notification.executor.js';
import type { NotificationMessage } from '../notification.types.js';

const message = (
    channel: NotificationMessage['channel'],
): NotificationMessage => ({
    channel,
    recipient: 'x',
    template: 'staff-invite',
    data: {
        name: 'n',
        role: 'r',
        email: 'e',
        temporaryPassword: 'p',
        loginUrl: 'u',
    },
});

describe('NotificationDispatcher', () => {
    const email: NotificationExecutor = { channel: 'EMAIL', send: vi.fn() };
    const whatsapp: NotificationExecutor = {
        channel: 'WHATSAPP',
        send: vi.fn(),
    };
    const dispatcher = new NotificationDispatcher([email, whatsapp]);

    beforeEach(() => vi.clearAllMocks());

    it('hands the message to the executor for its channel only', async () => {
        await dispatcher.dispatch(message('WHATSAPP'));

        expect(whatsapp.send).toHaveBeenCalledWith(message('WHATSAPP'));
        expect(email.send).not.toHaveBeenCalled();
    });

    it('fails without retrying when no executor handles the channel', async () => {
        await expect(dispatcher.dispatch(message('SMS'))).rejects.toMatchObject(
            {
                name: 'UnrecoverableError',
                message: expect.stringContaining('SMS'),
            },
        );
    });

    it('lets an executor error through so the queue can retry', async () => {
        vi.mocked(email.send).mockRejectedValueOnce(new Error('SES is down'));

        await expect(dispatcher.dispatch(message('EMAIL'))).rejects.toThrow(
            'SES is down',
        );
    });
});
