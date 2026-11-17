/** India has no daylight saving, so one fixed offset cuts its months correctly. */
const IST_OFFSET_MS = 330 * 60_000;

/** The instant India's calendar month containing `at` began. */
export function startOfIstMonth(at: Date): Date {
    const local = new Date(at.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST_OFFSET_MS);
}
