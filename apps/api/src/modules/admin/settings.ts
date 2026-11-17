import { z } from 'zod';

/**
 * The settings an admin can change. Each has a default, so a fresh database works without any row. Only settings
 * something actually reads belong here: the reports read both of these.
 */
export const SETTINGS = {
    'reports.firstResponseTargetMinutes': {
        label: 'First response target',
        help: 'How soon a new lead should get its first call, message or note. The first-response report counts leads reached within this time.',
        unit: 'minutes',
        default: 60,
        min: 5,
        max: 10_080,
    },
    'reports.stageStaleDays': {
        label: 'Stuck in a stage after',
        help: 'An open opportunity that has sat in one stage this long is counted as stuck in the stage-aging report.',
        unit: 'days',
        default: 7,
        min: 1,
        max: 90,
    },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export const updateSettingsSchema = z
    .strictObject({
        'reports.firstResponseTargetMinutes': z.number('Enter a number of minutes').int('Use whole minutes').min(5, 'At least 5 minutes').max(10_080, 'At most 7 days').optional(),
        'reports.stageStaleDays': z.number('Enter a number of days').int('Use whole days').min(1, 'At least 1 day').max(90, 'At most 90 days').optional(),
    })
    .refine((b) => Object.keys(b).length > 0, { message: 'Change at least one setting' });
export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>;

export interface SettingView {
    key: SettingKey;
    label: string;
    help: string;
    unit: string;
    value: number;
    default: number;
    min: number;
    max: number;
}

/** The stored value if it is a valid number for the setting, otherwise the default. */
export function resolveSetting(key: SettingKey, stored: unknown): number {
    const def = SETTINGS[key];
    const raw = typeof stored === 'object' && stored !== null && 'v' in stored ? (stored as { v: unknown }).v : stored;
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= def.min && raw <= def.max ? raw : def.default;
}
