import { z } from 'zod';
import { emailSchema } from './auth.schemas.js';
import { Role } from './iam.types.js';
import { normalisePhone } from './phone.js';

const nameSchema = z
    .string('Enter a name')
    .trim()
    .min(2, 'Enter a name')
    .max(100, 'Name is too long');

/** A mobile number in any usual spelling, stored as +<country code><number>. */
export const phoneSchema = z
    .string('Enter a phone number')
    .trim()
    .min(1, 'Enter a phone number')
    .max(30, 'Phone number is too long')
    .transform((value, ctx) => {
        const phone = normalisePhone(value);
        if (phone === null) {
            ctx.addIssue({
                code: 'custom',
                message:
                    'Enter a 10-digit mobile number, or add the country code (+44 ...) for a number outside India',
            });
            return z.NEVER;
        }
        return phone;
    });

const roleSchema = z.enum(
    Object.values(Role) as [Role, ...Role[]],
    'Choose a role',
);

export const createStaffSchema = z.object(
    {
        name: nameSchema,
        email: emailSchema,
        phone: phoneSchema,
        role: roleSchema,
    },
    'Send a JSON body with name, email, phone and role',
);

export type CreateStaffBody = z.infer<typeof createStaffSchema>;

export const staffIdSchema = z.uuid('Invalid staff id');

/** Email is the sign-in identity, so it is not editable here. */
export const updateStaffSchema = z
    .object(
        {
            name: nameSchema.optional(),
            role: roleSchema.optional(),
            phone: phoneSchema.optional(),
        },
        'Send a JSON body with a name, a role, a phone number or any of them',
    )
    .refine(
        (body) =>
            body.name !== undefined ||
            body.role !== undefined ||
            body.phone !== undefined,
        'Send a name, a role, a phone number or any of them',
    );

export type UpdateStaffBody = z.infer<typeof updateStaffSchema>;

/** What a signed-in person may change about themselves: their own phone number. */
export const updateOwnProfileSchema = z.object(
    { phone: phoneSchema },
    'Send a JSON body with your phone number',
);

export type UpdateOwnProfileBody = z.infer<typeof updateOwnProfileSchema>;

export const listStaffQuerySchema = z.object({
    search: z.string().trim().max(100, 'Search is too long').optional(),
    role: roleSchema.optional(),
    status: z
        .enum(['PENDING', 'ACTIVE', 'DEACTIVATED'], 'Unknown status')
        .optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;
