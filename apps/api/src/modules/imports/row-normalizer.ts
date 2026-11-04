import { type ColumnMapping, customFieldKey, type FieldKey } from './import-fields.js';

export type UserTypeValue = 'WORKING_PROFESSIONAL' | 'STUDENT' | 'UNKNOWN';

/** A row, cleaned up and ready to become a lead. */
export interface NormalizedLead {
    fullName: string;
    email: string | null;
    phoneE164: string | null;
    /** The last ten digits: the key phone numbers are matched on. */
    phoneLast10: string | null;
    currentCompany: string | null;
    currentCtc: string | null;
    graduationYear: string | null;
    domain: string | null;
    userType: UserTypeValue;
    leadScore: number;
    sourceDetail: string | null;
    /** New-field values, by field key. */
    custom: Record<string, string>;
}

export type RowEvaluation =
    | { ok: true; lead: NormalizedLead; warnings: string[] }
    | { ok: false; error: string };

export const SCORE_LIMITS = { min: 0, max: 10_000 } as const;

const LIMITS = {
    name: 150,
    email: 150,
    company: 255,
    ctc: 100,
    domain: 255,
    sourceDetail: 150,
    custom: 500,
} as const;

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export type EmailResult = { ok: true; email: string } | { ok: false };

export function parseEmail(raw: string): EmailResult {
    const value = raw.trim().replace(/^mailto:/i, '').trim().toLowerCase();
    if (
        value.length > LIMITS.email ||
        !/^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/.test(value) ||
        value.includes('..')
    ) {
        return { ok: false };
    }
    return { ok: true, email: value };
}

export type PhoneResult =
    | { ok: true; e164: string; last10: string }
    | { ok: false; reason: string };

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Reads a phone number the way people actually write it: "98765 43210", "+91-98765-43210",
 * "09876543210", Facebook's "p:+919876543210". A number with no country code is taken as Indian
 * and must be a mobile (starts 6-9, ten digits). Numbers with another country code are kept if
 * they are a plausible length.
 */
export function parsePhone(raw: string): PhoneResult {
    let value = raw.trim().replace(/^(p|tel):/i, '').trim();
    if (/^\d+(\.\d+)?e\+?\d+$/i.test(value)) {
        return {
            ok: false,
            reason: 'Phone looks like Excel turned it into scientific notation. Format the column as text and export again.',
        };
    }
    // "9876543210.0" is what a number column becomes after a round trip through a spreadsheet.
    value = value.replace(/^(\d+)\.0+$/, '$1');
    if (/[a-z]/i.test(value)) {
        return { ok: false, reason: 'Phone is not a valid number.' };
    }
    const digits = value.replace(/\D/g, '');
    if (digits === '') return { ok: false, reason: 'Phone has no digits.' };
    if (/^(\d)\1+$/.test(digits)) {
        return { ok: false, reason: 'Phone is not a valid number.' };
    }

    const indian = (national: string): PhoneResult =>
        INDIAN_MOBILE.test(national)
            ? { ok: true, e164: `+91${national}`, last10: national }
            : { ok: false, reason: 'Phone is not a valid Indian mobile number.' };

    const hasPlus = value.startsWith('+');
    const hasDoubleZero = !hasPlus && digits.startsWith('00');
    if (hasPlus || hasDoubleZero) {
        const international = hasDoubleZero ? digits.slice(2) : digits;
        if (international.startsWith('91')) return indian(international.slice(2));
        if (international.length >= 8 && international.length <= 15 && !international.startsWith('0')) {
            return { ok: true, e164: `+${international}`, last10: international.slice(-10) };
        }
        return { ok: false, reason: 'Phone is not a valid number.' };
    }
    if (digits.length === 10) return indian(digits);
    if (digits.length === 11 && digits.startsWith('0')) return indian(digits.slice(1));
    if (digits.length === 12 && digits.startsWith('91')) return indian(digits.slice(2));
    return { ok: false, reason: 'Phone is not a valid Indian mobile number.' };
}

export function parseUserType(raw: string): UserTypeValue | null {
    const value = raw.toLowerCase();
    // "Working professional" is checked first: "working professional (recent graduate)" is not a student.
    if (/working|professional|employed|experienced/.test(value)) {
        return 'WORKING_PROFESSIONAL';
    }
    if (/student/.test(value)) return 'STUDENT';
    return null;
}

/** Columns resolved to what evaluateRow needs: one index per built-in field, and a key per custom column. */
export interface ResolvedMapping {
    fields: Partial<Record<FieldKey, number>>;
    custom: { index: number; key: string; label: string }[];
}

export function resolveMapping(columns: ColumnMapping[]): ResolvedMapping {
    const fields: ResolvedMapping['fields'] = {};
    const custom: ResolvedMapping['custom'] = [];
    for (const column of columns) {
        if (column.target === 'skip') continue;
        if (column.target === 'custom') {
            const label = (column.label ?? '').trim();
            custom.push({ index: column.index, key: customFieldKey(label), label });
        } else {
            fields[column.target] = column.index;
        }
    }
    return { fields, custom };
}

/**
 * Turns one row into a lead, or says why it cannot be one. A row needs a name and at least one
 * usable email or phone, because those are what find duplicates. Anything else that is wrong with
 * the row is dropped with a warning and the lead is still imported: a typo in "graduation year"
 * should not lose the lead.
 */
export function evaluateRow(
    cells: string[],
    mapping: ResolvedMapping,
    now: Date = new Date(),
): RowEvaluation {
    const cell = (field: FieldKey): string => {
        const index = mapping.fields[field];
        return index === undefined ? '' : (cells[index] ?? '');
    };
    const warnings: string[] = [];

    const rawName =
        cell('name') !== ''
            ? cell('name')
            : [cell('firstName'), cell('lastName')].filter((p) => p !== '').join(' ');
    const fullName = collapse(rawName);
    if (fullName === '') return { ok: false, error: 'Name is missing.' };
    if (fullName.length > LIMITS.name) return { ok: false, error: 'Name is too long.' };

    const rawEmail = cell('email');
    const rawPhone = cell('phone');
    if (rawEmail === '' && rawPhone === '') {
        return { ok: false, error: 'The row has no email or phone.' };
    }
    const email = rawEmail === '' ? null : parseEmail(rawEmail);
    const phone = rawPhone === '' ? null : parsePhone(rawPhone);
    const goodEmail = email?.ok ? email.email : null;
    const goodPhone = phone?.ok ? phone : null;
    if (goodEmail === null && goodPhone === null) {
        if (email && !email.ok && phone && !phone.ok) {
            return { ok: false, error: 'Neither the email nor the phone number is valid.' };
        }
        if (phone && !phone.ok) return { ok: false, error: phone.reason };
        return { ok: false, error: 'Email is not valid.' };
    }
    if (email && !email.ok) warnings.push('Email is not valid, so it was left out.');
    if (phone && !phone.ok) warnings.push(`${phone.reason.replace(/\.$/, '')}, so it was left out.`);

    const text = (field: FieldKey, label: string, max: number): string | null => {
        const value = collapse(cell(field));
        if (value === '') return null;
        if (value.length > max) {
            warnings.push(`${label} is too long, so it was left out.`);
            return null;
        }
        return value;
    };

    let graduationYear: string | null = null;
    const rawYear = collapse(cell('gradYear'));
    if (rawYear !== '') {
        const match = /^(\d{4})(\.0+)?$/.exec(rawYear);
        const year = match ? Number(match[1]) : NaN;
        if (year >= 1970 && year <= now.getFullYear() + 8) {
            graduationYear = String(year);
        } else {
            warnings.push('Graduation year is not a valid year, so it was left out.');
        }
    }

    let userType: UserTypeValue = 'UNKNOWN';
    const rawType = collapse(cell('userType'));
    if (rawType !== '') {
        const parsed = parseUserType(rawType);
        if (parsed) userType = parsed;
        else warnings.push('Working professional or student was not recognised, so it was left out.');
    }

    let leadScore = 0;
    const rawScore = collapse(cell('leadScore'));
    if (rawScore !== '') {
        const match = /^\+?(\d{1,6})(\.0+)?$/.exec(rawScore);
        const score = match ? Number(match[1]) : NaN;
        if (score >= SCORE_LIMITS.min && score <= SCORE_LIMITS.max) {
            leadScore = score;
        } else {
            warnings.push(
                `Lead score must be a whole number from ${SCORE_LIMITS.min} to ${SCORE_LIMITS.max.toLocaleString('en-IN')}, so it was left out.`,
            );
        }
    }

    const custom: Record<string, string> = {};
    for (const column of mapping.custom) {
        const value = collapse(cells[column.index] ?? '');
        if (value === '') continue;
        if (value.length > LIMITS.custom) {
            warnings.push(`${column.label} is too long, so it was left out.`);
        } else {
            custom[column.key] = value;
        }
    }

    return {
        ok: true,
        warnings,
        lead: {
            fullName,
            email: goodEmail,
            phoneE164: goodPhone?.e164 ?? null,
            phoneLast10: goodPhone?.last10 ?? null,
            currentCompany: text('company', 'Company', LIMITS.company),
            currentCtc: text('ctc', 'CTC', LIMITS.ctc),
            graduationYear,
            domain: text('domain', 'Domain', LIMITS.domain),
            userType,
            leadScore,
            sourceDetail: text('sourceDetail', 'Source details', LIMITS.sourceDetail),
            custom,
        },
    };
}
