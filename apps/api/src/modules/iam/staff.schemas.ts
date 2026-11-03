import { z } from 'zod';
import { emailSchema } from './auth.schemas.js';
import { Role } from './iam.types.js';

const nameSchema = z
    .string('Enter a name')
    .trim()
    .min(2, 'Enter a name')
    .max(100, 'Name is too long');

const roleSchema = z.enum(
    Object.values(Role) as [Role, ...Role[]],
    'Choose a role',
);

export const createStaffSchema = z.object(
    {
        name: nameSchema,
        email: emailSchema,
        role: roleSchema,
    },
    'Send a JSON body with name, email and role',
);

export type CreateStaffBody = z.infer<typeof createStaffSchema>;

export const staffIdSchema = z.uuid('Invalid staff id');

/** Email is the sign-in identity, so it is not editable here. */
export const updateStaffSchema = z
    .object(
        { name: nameSchema.optional(), role: roleSchema.optional() },
        'Send a JSON body with a name, a role or both',
    )
    .refine(
        (body) => body.name !== undefined || body.role !== undefined,
        'Send a name, a role or both',
    );

export type UpdateStaffBody = z.infer<typeof updateStaffSchema>;

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
