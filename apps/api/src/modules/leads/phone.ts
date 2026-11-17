/**
 * An Indian mobile number as the CRM stores it: +91 and the last ten digits. Accepts the ways people
 * type one (spaces, dashes, a leading 0, +91 or 91). Null when it is not a valid Indian mobile.
 */
export function normaliseMobile(raw: string | null | undefined): { phoneE164: string; phoneLast10: string } | null {
    if (!raw) return null;
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(digits)) return null;
    return { phoneE164: `+91${digits}`, phoneLast10: digits };
}
