import type { Role } from '@app/rbac';

export const FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTISELECT', 'BOOLEAN'] as const;
export type FieldTypeName = (typeof FIELD_TYPES)[number];

export interface FieldDef {
    key: string;
    label: string;
    type: FieldTypeName;
    options: string[];
    isRequired: boolean;
    visibleRoles: Role[];
}

/** A stable key from a label: "Preferred batch" becomes preferred_batch. */
export function keyFromLabel(label: string): string {
    return label
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
}

export type Checked = { ok: true; value: string | number | boolean | string[] | null } | { ok: false; message: string };

/**
 * Checks one typed value against its field. An empty value clears the field (null). Dates are days (2026-11-30),
 * selects hold one of the field's options, multi-selects a list of them.
 */
export function checkFieldValue(def: Pick<FieldDef, 'label' | 'type' | 'options'>, raw: unknown): Checked {
    const bad = (message: string): Checked => ({ ok: false, message });
    if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: null };
    switch (def.type) {
        case 'TEXT': {
            if (typeof raw !== 'string') return bad(`${def.label} must be text`);
            const text = raw.trim();
            if (text.length > 500) return bad(`${def.label} is too long`);
            return { ok: true, value: text === '' ? null : text };
        }
        case 'NUMBER': {
            const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
            return Number.isFinite(n) ? { ok: true, value: n } : bad(`${def.label} must be a number`);
        }
        case 'DATE': {
            if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) {
                return bad(`${def.label} must be a date like 2026-11-30`);
            }
            return { ok: true, value: raw };
        }
        case 'SELECT':
            return typeof raw === 'string' && def.options.includes(raw) ? { ok: true, value: raw } : bad(`Choose one of the options for ${def.label}`);
        case 'MULTISELECT': {
            if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string' && def.options.includes(v))) {
                return bad(`Choose only the listed options for ${def.label}`);
            }
            return { ok: true, value: [...new Set(raw as string[])] };
        }
        case 'BOOLEAN':
            return typeof raw === 'boolean' ? { ok: true, value: raw } : bad(`${def.label} must be yes or no`);
    }
}
