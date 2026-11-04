export interface ImportAssignmentInput {
    leadId: bigint;
    toUserId: bigint;
    byUserId: bigint | null;
    sourceId: number;
    /** The import's public id: one batch per import, so the log can be filtered by it. */
    batchId: string;
}
