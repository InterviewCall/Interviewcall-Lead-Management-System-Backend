import { z } from 'zod';

/** What WorkR's User-Service sends about a new signup. */
export const workrSignupSchema = z.object({
    userId: z.number().int().positive(),
    fullName: z.string().trim().min(1).max(150),
    email: z.string().trim().toLowerCase().max(150).pipe(z.email()),
    phoneNo: z.string().trim().max(20).nullish(),
    /** "Working Professional" or "Student". Only the first goes on to become a lead. */
    details: z.string().trim().max(100).nullish(),
    domain: z.string().trim().max(255).nullish(),
    currentCompany: z.string().trim().max(255).nullish(),
    currentCtc: z.string().trim().max(100).nullish(),
    graduationYear: z.string().trim().max(10).nullish(),
});

export type WorkrSignup = z.infer<typeof workrSignupSchema>;

/** Only working professionals become leads. Anything else (Student, missing, unexpected) is left out. */
export const isWorkingProfessional = (details: string | null | undefined): boolean =>
    typeof details === 'string' && details.trim().toLowerCase() === 'working professional';

/** A 10-digit Indian mobile, from the ways people write one (+91, 91, 0 in front, spaces). */
export function normalisePhone(raw: string | null | undefined): { phoneE164: string; phoneLast10: string } | null {
    if (!raw) return null;
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(digits)) return null;
    return { phoneE164: `+91${digits}`, phoneLast10: digits };
}

const IST = 'Asia/Kolkata';

/** The Indian calendar day an instant falls on, as 2026-11-05. */
export function istDayKey(at: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The same day for people: 5 Nov 2026. */
export function istDayLabel(at: Date): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}
