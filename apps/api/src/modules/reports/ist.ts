/** India has no daylight saving, so one fixed offset cuts its days and weeks correctly. */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The instant India's day containing `at` began. */
export function startOfIstDay(at: Date): Date {
    return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

export const addDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS);

/** YYYY-MM-DD of the India date. */
export function istDateKey(at: Date): string {
    return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Monday that began the India week containing `at`. */
export function startOfIstWeek(at: Date): Date {
    const dayStart = startOfIstDay(at);
    const weekday = new Date(dayStart.getTime() + IST_OFFSET_MS).getUTCDay(); // 0 = Sunday
    return addDays(dayStart, -((weekday + 6) % 7));
}
