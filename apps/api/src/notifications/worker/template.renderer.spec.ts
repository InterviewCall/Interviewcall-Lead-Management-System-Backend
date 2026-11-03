import { TemplateRenderer } from './template.renderer.js';

const data = {
    name: 'Ravi Kumar',
    role: 'Sales Manager',
    email: 'ravi@example.com',
    temporaryPassword: 'Xk4mN8qRt2WpZ9',
    loginUrl: 'https://crm.interviewcall.club/login',
};

describe('TemplateRenderer', () => {
    const renderer = new TemplateRenderer();

    it('renders the staff invite with the person, the role and the one-time password', () => {
        const email = renderer.render({ template: 'staff-invite', data });

        expect(email.subject).toBe('Your InterviewCall CRM account');
        for (const body of [email.html, email.text]) {
            expect(body).toContain('Ravi Kumar');
            expect(body).toContain('Sales Manager');
            expect(body).toContain('ravi@example.com');
            expect(body).toContain('Xk4mN8qRt2WpZ9');
            expect(body).toContain('https://crm.interviewcall.club/login');
        }
        expect(email.html).toContain('<html');
        expect(email.text).not.toContain('<');
    });

    it('escapes markup in the HTML body but not in plain text', () => {
        const email = renderer.render({
            template: 'staff-invite',
            data: { ...data, name: '<script>alert(1)</script> & Co' },
        });

        expect(email.html).not.toContain('<script>');
        expect(email.html).toContain('&lt;script&gt;');
        expect(email.text).toContain('<script>alert(1)</script> & Co');
    });

    it('fails without retrying for a template that does not exist', () => {
        expect(() =>
            renderer.render({ template: 'nope' as 'staff-invite', data }),
        ).toThrowError(expect.objectContaining({ name: 'UnrecoverableError' }));
    });

    it('refuses to render with a missing field instead of sending a blank', () => {
        const { temporaryPassword: _omitted, ...incomplete } = data;

        expect(() =>
            renderer.render({
                template: 'staff-invite',
                data: incomplete as typeof data,
            }),
        ).toThrow();
    });
});
