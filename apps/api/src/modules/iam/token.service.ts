import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';
import type { Role } from './iam.types.js';

export const ACCESS_TOKEN_ISSUER = 'interviewcall-crm';

export interface AccessTokenClaims {
    publicId: string;
    role: Role;
    /** The session family, so the signed-in session can be ended from its own token. */
    familyId: string;
}

@Injectable()
export class TokenService {
    constructor(@Inject(IAM_CONFIG) private readonly config: IamConfig) {}

    signAccessToken(claims: AccessTokenClaims): Promise<string> {
        return new SignJWT({ role: claims.role, fam: claims.familyId })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(claims.publicId)
            .setIssuer(ACCESS_TOKEN_ISSUER)
            .setIssuedAt()
            .setExpirationTime(`${this.config.accessTtlSeconds}s`)
            .sign(this.config.accessSecret);
    }

    /** A random refresh token and the SHA-256 hash that is stored in auth_sessions. */
    newRefreshToken(): { token: string; hash: string } {
        const token = randomBytes(32).toString('base64url');
        return { token, hash: this.hash(token) };
    }

    hash(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    /** Double-submit token: set in a readable cookie and echoed in the X-CSRF-Token header. */
    newCsrfToken(): string {
        return randomBytes(24).toString('base64url');
    }
}
