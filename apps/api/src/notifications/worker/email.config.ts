import { z } from 'zod';

export const EMAIL_CONFIG = Symbol('EMAIL_CONFIG');

export interface EmailConfig {
    region: string;
    /** A sender SES has verified, e.g. "InterviewCall CRM <crm@interviewcall.club>". */
    from: string;
    /** Where replies go. Empty means replies go to `from`. */
    replyTo: string[];
    configurationSet: string | undefined;
}

/** True for "a@b.com" and for "Name <a@b.com>". */
function isEmailAddress(entry: string): boolean {
    const address = /<([^<>]+)>\s*$/.exec(entry)?.[1] ?? entry;
    return z.email().safeParse(address.trim()).success;
}

const envSchema = z.object({
    AWS_REGION: z.string().trim().min(1, 'is required'),
    EMAIL_FROM: z.string().trim().min(3, 'is required'),
    // One address, or several separated by commas. Optional.
    EMAIL_REPLY_TO: z
        .string()
        .trim()
        .optional()
        .transform((value, ctx) => {
            const entries = (value ?? '')
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            const invalid = entries.find((entry) => !isEmailAddress(entry));
            if (invalid) {
                ctx.addIssue({
                    code: 'custom',
                    message: `"${invalid}" is not an email address`,
                });
                return z.NEVER;
            }
            return entries;
        }),
    SES_CONFIGURATION_SET: z.string().trim().optional(),
});

/**
 * Reads the email settings when the worker starts, so a missing sender stops the worker at boot
 * instead of failing the first email. Credentials come from the AWS default chain
 * (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or an instance role).
 */
export function loadEmailConfig(
    env: NodeJS.ProcessEnv = process.env,
): EmailConfig {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ');
        throw new Error(`Invalid email configuration. ${details}`);
    }
    return {
        region: parsed.data.AWS_REGION,
        from: parsed.data.EMAIL_FROM,
        replyTo: parsed.data.EMAIL_REPLY_TO,
        configurationSet: parsed.data.SES_CONFIGURATION_SET || undefined,
    };
}
