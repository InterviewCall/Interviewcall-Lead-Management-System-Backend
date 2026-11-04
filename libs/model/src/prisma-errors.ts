import { Prisma } from '@app/prisma';

/** True when a write failed because a unique index already holds that value (Prisma's P2002). */
export function isUniqueViolation(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
    );
}
