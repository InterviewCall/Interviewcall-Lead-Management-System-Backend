import { Injectable } from '@nestjs/common';
import { AssignmentRepository } from './assignment.repository.js';
import type { ImportAssignmentInput } from './assignment.types.js';

@Injectable()
export class AssignmentService {
    constructor(private readonly repository: AssignmentRepository) {}

    /**
     * Writes the assignment log line for a lead an import gave to someone. With `mayExist` it first
     * checks that this import has not already written it (a retried row); a brand-new lead cannot
     * have one, so the importer skips the check.
     */
    async recordImportAssignment(
        input: ImportAssignmentInput,
        options: { mayExist: boolean } = { mayExist: true },
    ): Promise<void> {
        if (options.mayExist && (await this.repository.hasBatchEntry(input.leadId, input.batchId))) {
            return;
        }
        await this.repository.insertImportEntry(input);
    }
}
