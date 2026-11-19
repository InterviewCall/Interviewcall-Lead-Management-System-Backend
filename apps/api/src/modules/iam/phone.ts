/**
 * Staff phone numbers are stored in international form (E.164), such as +919876543210, because
 * that is what WhatsApp needs. People type them many ways, so this accepts the usual ones and
 * always returns the same shape.
 *
 * - A 10-digit Indian mobile number (starts with 6 to 9), with or without a leading 0, 91 or +91,
 *   becomes +91 followed by the ten digits.
 * - A number that starts with + is taken as written, as long as it has 8 to 15 digits and does not
 *   start with 0 after the +.
 * - Anything else is not a number we can send to.
 *
 * Returns null when the input is not a usable number.
 */
export function normalisePhone(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed === '' || !/^[+\d\s().-]+$/.test(trimmed)) return null;

    const digits = trimmed.replace(/\D/g, '');
    if (trimmed.startsWith('+')) {
        return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
    }

    const local =
        digits.length === 10
            ? digits
            : digits.length === 11 && digits.startsWith('0')
              ? digits.slice(1)
              : digits.length === 12 && digits.startsWith('91')
                ? digits.slice(2)
                : null;
    return local !== null && /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null;
}
