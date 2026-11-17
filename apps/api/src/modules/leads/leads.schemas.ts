import { z } from 'zod';
import { LEAD_VIEWS } from './leads.types.js';

export const leadIdSchema = z.uuid('Invalid lead id');

const STAGES = [
    'CALL_1_PENDING',
    'CALL_1',
    'TEST',
    'CALL_2',
    'PSYCHOMETRIC_SESSION',
    'DECISION_OBJECTION',
    'PAYMENT_FINANCING',
    'CLOSED_WON',
] as const;

export const LIFECYCLES = [
    'MARKETING_LEAD',
    'ENGAGED_LEAD',
    'PROSPECT',
    'ENROLLED',
    'LEARNER_ONBOARDED',
    'NOT_INTERESTED',
    'EXHAUSTED_NOT_CONNECTED',
] as const;

export const contactStageSchema = z.strictObject({
    stage: z.enum(LIFECYCLES, 'Choose a contact stage'),
});

export type ContactStageBody = z.infer<typeof contactStageSchema>;

/** At most this many leads change in one bulk action. */
export const BULK_MAX = 500;

/** The leads a bulk action applies to. */
export const bulkLeadIdsSchema = z
    .array(z.uuid('Invalid lead id'), 'Choose the leads')
    .min(1, 'Choose at least one lead')
    .max(BULK_MAX, `Choose at most ${BULK_MAX} leads at a time`);

export const bulkContactStageSchema = z.strictObject({
    leadIds: bulkLeadIdsSchema,
    stage: z.enum(LIFECYCLES, 'Choose a contact stage'),
});

export type BulkContactStageBody = z.infer<typeof bulkContactStageSchema>;

export const listLeadsQuerySchema = z.object({
    view: z.enum(LEAD_VIEWS, 'Unknown view').default('all'),
    search: z.string().trim().max(100, 'Search is too long').optional(),
    sourceId: z.coerce.number().int().positive().optional(),
    temperature: z.enum(['HOT', 'WARM', 'COLD'], 'Unknown temperature').optional(),
    stage: z.enum(STAGES, 'Unknown stage').optional(),
    lifecycle: z.enum(LIFECYCLES, 'Unknown contact stage').optional(),
    ownerId: z.union([z.uuid('Invalid owner'), z.literal('none')]).optional(),
    listId: z.uuid('Invalid list').optional(),
    /** Days as YYYY-MM-DD, in India time. `to` is inclusive. */
    from: z.iso.date('Use a date like 2026-11-01').optional(),
    to: z.iso.date('Use a date like 2026-11-30').optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/** An export takes the list's filters but no page. */
export const exportLeadsQuerySchema = listLeadsQuerySchema.omit({ page: true, pageSize: true });
export type ExportLeadsQuery = z.infer<typeof exportLeadsQuerySchema>;

// ---- adding and editing a lead by hand ----

const optionalText = (max: number, label: string) =>
    z
        .string()
        .trim()
        .max(max, `${label} is too long`)
        .transform((v) => (v === '' ? null : v))
        .nullable();

const thisYear = new Date().getFullYear();
const graduationYear = z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .refine((v) => v === null || (/^\d{4}$/.test(v) && Number(v) >= 1970 && Number(v) <= thisYear + 6), 'Enter a year like 2021');

const email = z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .refine((v) => v === null || (v.length <= 150 && z.email().safeParse(v).success), 'Enter a valid email address');

/** A phone as typed; checked and normalised by the service, so the message can name the field. */
const phone = z
    .string()
    .trim()
    .max(20, 'Enter a 10-digit mobile number')
    .transform((v) => (v === '' ? null : v))
    .nullable();

const profileShape = {
    currentCompany: optionalText(255, 'Company'),
    currentCtc: optionalText(100, 'CTC'),
    graduationYear,
    domain: optionalText(255, 'Domain'),
};

export const createLeadSchema = z.strictObject(
    {
        fullName: z.string().trim().min(2, 'Enter the full name').max(150, 'The name is too long'),
        phone: phone.default(null),
        email: email.default(null),
        sourceId: z.number('Choose where the lead came from').int().positive('Choose where the lead came from'),
        /** Managers and admins may choose; a BDA always owns what they add. Null leaves it unassigned. */
        ownerId: z.uuid('Choose an owner').nullable().default(null),
        currentCompany: profileShape.currentCompany.default(null),
        currentCtc: profileShape.currentCtc.default(null),
        graduationYear: profileShape.graduationYear.default(null),
        domain: profileShape.domain.default(null),
    },
    'Send a JSON body with the lead',
);
export type CreateLeadBody = z.infer<typeof createLeadSchema>;

/** Only the fields sent change; null clears an optional one. */
export const editLeadSchema = z
    .strictObject(
        {
            fullName: z.string().trim().min(2, 'Enter the full name').max(150, 'The name is too long').optional(),
            phone: phone.optional(),
            email: email.optional(),
            currentCompany: profileShape.currentCompany.optional(),
            currentCtc: profileShape.currentCtc.optional(),
            graduationYear: profileShape.graduationYear.optional(),
            domain: profileShape.domain.optional(),
        },
        'Send a JSON body with the fields to change',
    )
    .refine((body) => Object.keys(body).length > 0, 'Change at least one field');
export type EditLeadBody = z.infer<typeof editLeadSchema>;

// ---- lead sources (admin) ----

/** Groups an admin may give a source. WorkR, VSL and CSV import belong to the CRM's own sources. */
export const MANUAL_SOURCE_GROUPS = ['REFERRAL', 'ORGANIC', 'META', 'OTHER'] as const;

const sourceName = z.string().trim().min(2, 'Enter a name').max(80, 'The name is too long');

export const sourceIdSchema = z.coerce.number('Invalid source').int('Invalid source').positive('Invalid source');

export const createSourceSchema = z.strictObject(
    { name: sourceName, group: z.enum(MANUAL_SOURCE_GROUPS, 'Choose a kind of source') },
    'Send a JSON body with name and group',
);
export type CreateSourceBody = z.infer<typeof createSourceSchema>;

export const updateSourceSchema = z
    .strictObject(
        {
            name: sourceName.optional(),
            group: z.enum(MANUAL_SOURCE_GROUPS, 'Choose a kind of source').optional(),
            isActive: z.boolean('Send true or false').optional(),
        },
        'Send a JSON body with the fields to change',
    )
    .refine((b) => Object.keys(b).length > 0, 'Change at least one field');
export type UpdateSourceBody = z.infer<typeof updateSourceSchema>;

// ---- saved views ----

/** What a saved view remembers: any of the list's filters. */
export const savedViewFiltersSchema = exportLeadsQuerySchema.partial().strict();

export const MAX_SAVED_VIEWS = 20;

export const createSavedViewSchema = z.strictObject(
    {
        name: z.string().trim().min(2, 'Enter a name').max(40, 'The name is too long'),
        filters: savedViewFiltersSchema,
        /** Everyone sees a shared view. Managers and admins only. */
        shared: z.boolean('Send true or false').default(false),
    },
    'Send a JSON body with name and filters',
);
export type CreateSavedViewBody = z.infer<typeof createSavedViewSchema>;

export const savedViewIdSchema = z.coerce.number('Invalid view').int('Invalid view').positive('Invalid view');

// ---- custom fields ----

const CUSTOM_ROLES = ['ADMIN', 'SALES_MANAGER', 'OPS', 'BDA', 'CLOSER'] as const;
const fieldOptions = z
    .array(z.string().trim().min(1, 'An option cannot be empty').max(60, 'An option is too long'), 'Send the options as a list')
    .max(30, 'At most 30 options')
    .refine((o) => new Set(o.map((v) => v.toLowerCase())).size === o.length, 'Each option must be different');

export const createCustomFieldSchema = z
    .strictObject(
        {
            label: z.string().trim().min(2, 'Enter a name').max(60, 'The name is too long'),
            type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTISELECT', 'BOOLEAN'], 'Choose a type'),
            options: fieldOptions.default([]),
            isRequired: z.boolean('Send true or false').default(false),
            visibleRoles: z.array(z.enum(CUSTOM_ROLES, 'Unknown role')).min(1, 'Choose who can see it').default([...CUSTOM_ROLES]),
        },
        'Send a JSON body with the field',
    )
    .refine((b) => !['SELECT', 'MULTISELECT'].includes(b.type) || b.options.length >= 2, { message: 'Add at least two options', path: ['options'] });
export type CreateCustomFieldBody = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = z
    .strictObject(
        {
            label: z.string().trim().min(2, 'Enter a name').max(60, 'The name is too long').optional(),
            options: fieldOptions.optional(),
            isRequired: z.boolean('Send true or false').optional(),
            visibleRoles: z.array(z.enum(CUSTOM_ROLES, 'Unknown role')).min(1, 'Choose who can see it').optional(),
            isActive: z.boolean('Send true or false').optional(),
        },
        'Send a JSON body with the fields to change',
    )
    .refine((b) => Object.keys(b).length > 0, 'Change at least one field');
export type UpdateCustomFieldBody = z.infer<typeof updateCustomFieldSchema>;

export const customKeySchema = z.string().regex(/^[a-z0-9_]{1,50}$/, 'Invalid field');

/** Values to set on a lead, by field key. Null (or empty) clears one. Checked against the field's type by the service. */
export const customValuesSchema = z.strictObject(
    { values: z.record(z.string().regex(/^[a-z0-9_]{1,50}$/, 'Invalid field'), z.unknown()).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50, 'Send between 1 and 50 values') },
    'Send a JSON body with values',
);
export type CustomValuesBody = z.infer<typeof customValuesSchema>;

export const doNotContactSchema = z.strictObject({
    value: z.boolean('Choose on or off'),
    reason: z.string().trim().max(300, 'Keep the reason under 300 characters').optional(),
});
export type DoNotContactBody = z.infer<typeof doNotContactSchema>;

/** At most this many numbers and emails per suppression check. */
export const SUPPRESSION_MAX = 1000;

export const suppressionCheckSchema = z
    .strictObject({
        phones: z.array(z.string().trim().max(32), 'Send phones as a list').max(SUPPRESSION_MAX, `At most ${SUPPRESSION_MAX} phones`).default([]),
        emails: z.array(z.string().trim().max(254), 'Send emails as a list').max(SUPPRESSION_MAX, `At most ${SUPPRESSION_MAX} emails`).default([]),
    })
    .refine((b) => b.phones.length + b.emails.length > 0, { message: 'Send at least one phone or email' });
export type SuppressionCheckBody = z.infer<typeof suppressionCheckSchema>;
