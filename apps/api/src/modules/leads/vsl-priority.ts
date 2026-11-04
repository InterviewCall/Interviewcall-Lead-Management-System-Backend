import type { TemperatureName, VslDepthName } from './leads.types.js';

const DEPTH_WEIGHT: Record<VslDepthName, number> = { NONE: 0, DETAILS: 1, FORM: 2, BOOKED: 3 };
const TEMPERATURE_WEIGHT: Record<TemperatureName, number> = { COLD: 1, WARM: 2, HOT: 3 };

/** How far a person got, so a later event can only move it forward. */
export const depthWeight = (depth: VslDepthName): number => DEPTH_WEIGHT[depth];

/**
 * The order a manager (or a BDA) should call VSL leads in; higher is called first.
 *   - how far they got matters most: a booked call, then a filled form, then only details;
 *   - then how warm the form says they are;
 *   - then the form score, to order people within one temperature.
 * A person who gave only details has no temperature and no score, so they rank below everyone who
 * filled the form at the same depth class.
 */
export function priorityRankOf(depth: VslDepthName, temperature: TemperatureName | null, formScore: number | null): number {
    const score = Math.max(0, Math.min(100, formScore ?? 0));
    return DEPTH_WEIGHT[depth] * 1000 + (temperature ? TEMPERATURE_WEIGHT[temperature] : 0) * 100 + Math.floor(score / 2);
}
