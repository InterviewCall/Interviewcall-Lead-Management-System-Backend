import { z } from 'zod';

/** Lower-cased and trimmed, because emails are stored and matched that way. */
export const emailSchema = z
    .string('Enter an email')
    .trim()
    .toLowerCase()
    .pipe(z.email('Enter a valid email').max(150, 'Email is too long'));

export const loginSchema = z.object(
    {
        email: emailSchema,
        // Passwords are never trimmed or altered. The cap only bounds the hashing work.
        password: z
            .string('Enter your password')
            .min(1, 'Enter your password')
            .max(128, 'Password is too long'),
    },
    'Send a JSON body with email and password',
);

export type LoginBody = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
    .object(
        {
            currentPassword: z
                .string('Enter your current password')
                .min(1, 'Enter your current password')
                .max(128, 'Password is too long'),
            newPassword: z
                .string('Choose a new password')
                .min(10, 'Use at least 10 characters')
                .max(128, 'Password is too long'),
        },
        'Send a JSON body with currentPassword and newPassword',
    )
    .refine((value) => value.currentPassword !== value.newPassword, {
        path: ['newPassword'],
        error: 'Choose a password different from the current one',
    });

export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
