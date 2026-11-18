/** India has no daylight saving, so one fixed offset cuts its months correctly. */
const IST_OFFSET_MS = 330 * 60_000;

/** The instant India's calendar month containing `at` began. */
export function startOfIstMonth(at: Date): Date {
    const local = new Date(at.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST_OFFSET_MS);
}

const DAY_MS = 86_400_000;

/** India's calendar day of `at`, as YYYY-MM-DD. */
export function istDate(at: Date): string {
    return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `day` (YYYY-MM-DD) moved by `days` calendar days. */
export function addDays(day: string, days: number): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
