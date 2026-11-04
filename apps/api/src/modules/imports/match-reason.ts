import type { IdentityKind } from '@modules/leads';

/**
 * Says what made a row a duplicate, so a person can tell "same phone, different email" from a
 * clean repeat. Email and phone are both used to find an existing lead; any one that matches counts.
 */
export function describeMatch(on: IdentityKind[]): string {
    const email = on.includes('EMAIL');
    const phone = on.includes('PHONE');
    if (email && phone) return 'same email and phone';
    if (email) return 'same email';
    if (phone) return 'same phone';
    return '';
}

/** "Already a lead (same phone)", or "Repeated in this file (row 4, same email)". */
export function duplicateMessage(
    firstRow: number | null,
    on: IdentityKind[],
): string {
    const why = describeMatch(on);
    if (firstRow !== null) {
        return `Repeated in this file (row ${firstRow}${why ? `, ${why}` : ''})`;
    }
    return why ? `Already a lead (${why})` : 'Already a lead';
}
