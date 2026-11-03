import { z } from 'zod';

export const loginSchema = z.object(
    {
        email: z
            .string('Enter your email')
            .trim()
            .toLowerCase()
            .pipe(z.email('Enter a valid email').max(150, 'Email is too long')),
        // Passwords are never trimmed or altered. The cap only bounds the hashing work.
        password: z
            .string('Enter your password')
            .min(1, 'Enter your password')
            .max(128, 'Password is too long'),
    },
    'Send a JSON body with email and password',
);

export type LoginBody = z.infer<typeof loginSchema>;
