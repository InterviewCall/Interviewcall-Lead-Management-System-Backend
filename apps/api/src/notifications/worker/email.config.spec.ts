import { loadEmailConfig } from './email.config.js';

describe('loadEmailConfig', () => {
    it('reads the region, sender and optional configuration set', () => {
        expect(
            loadEmailConfig({
                AWS_REGION: 'ap-south-1',
                EMAIL_FROM: 'CRM <crm@interviewcall.club>',
                SES_CONFIGURATION_SET: 'crm',
            }),
        ).toEqual({
            region: 'ap-south-1',
            from: 'CRM <crm@interviewcall.club>',
            replyTo: [],
            configurationSet: 'crm',
        });
    });

    it('treats an empty configuration set as none', () => {
        expect(
            loadEmailConfig({
                AWS_REGION: 'ap-south-1',
                EMAIL_FROM: 'crm@x.com',
                SES_CONFIGURATION_SET: '',
            }).configurationSet,
        ).toBeUndefined();
    });

    it('names every missing setting so the worker fails at boot', () => {
        expect(() => loadEmailConfig({})).toThrow(/AWS_REGION.*EMAIL_FROM/);
    });

    describe('EMAIL_REPLY_TO', () => {
        const base = { AWS_REGION: 'ap-south-1', EMAIL_FROM: 'crm@x.com' };

        it('is none when unset or empty', () => {
            expect(loadEmailConfig(base).replyTo).toEqual([]);
            expect(
                loadEmailConfig({ ...base, EMAIL_REPLY_TO: '  ' }).replyTo,
            ).toEqual([]);
        });

        it('reads one address, including one with a display name', () => {
            expect(
                loadEmailConfig({
                    ...base,
                    EMAIL_REPLY_TO:
                        'InterviewCall Support <support@interviewcall.club>',
                }).replyTo,
            ).toEqual(['InterviewCall Support <support@interviewcall.club>']);
        });

        it('reads several, separated by commas', () => {
            expect(
                loadEmailConfig({
                    ...base,
                    EMAIL_REPLY_TO: 'a@x.com, Team <b@x.com> ,',
                }).replyTo,
            ).toEqual(['a@x.com', 'Team <b@x.com>']);
        });

        it('stops the worker at boot on an address that is not one', () => {
            expect(() =>
                loadEmailConfig({ ...base, EMAIL_REPLY_TO: 'a@x.com, nope' }),
            ).toThrow(/EMAIL_REPLY_TO.*"nope" is not an email address/);
        });
    });
});
