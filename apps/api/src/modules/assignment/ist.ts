/** India has no daylight saving, so one fixed offset cuts its days correctly. */
const IST_OFFSET_MS = 330 * 60_000;

/** YYYY-MM-DD of the India date. */
export function istDateKey(at: Date): string {
    return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
