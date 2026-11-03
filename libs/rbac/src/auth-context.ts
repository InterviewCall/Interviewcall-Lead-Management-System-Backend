import type { Role } from './roles.js';

/** Who is making the request, taken from the verified access token. */
export interface AuthContext {
    /** The staff user's publicId (UUID), never the numeric key. */
    publicId: string;
    role: Role;
    /** The session family, so the current session can be ended from its own token. */
    familyId: string;
    /** True while the account still has a temporary password. */
    mustChangePassword: boolean;
}

declare module 'express-serve-static-core' {
    interface Request {
        auth?: AuthContext;
    }
}
