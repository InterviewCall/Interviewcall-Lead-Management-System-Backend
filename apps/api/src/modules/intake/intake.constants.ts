export const INTAKE_QUEUE = 'intake-events';

/** A failing event is tried this many times in all, then it needs a person (the Intake monitor's Retry). */
export const MAX_ATTEMPTS = 5;

/** Wait before the next try after the 1st, 2nd, 3rd ... failure. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000] as const;

/** A worker that takes an event and then dies holds it this long before another worker may take it. */
export const LOCK_MS = 5 * 60_000;

/** How often the worker looks for events nobody is handling. */
export const SWEEP_EVERY_MS = 60_000;

/** The event payload (personal details) is removed this many days after processing. */
export const PAYLOAD_KEEP_DAYS = 30;

/** The header the sender service puts its key in. */
export const INTAKE_KEY_HEADER = 'x-intake-key';
