import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
    ACCESS_TOKEN_ALGORITHM,
    ACCESS_TOKEN_ISSUER,
    accessTokenPayload,
    type AuthContext,
} from '@app/rbac';
import { SignJWT } from 'jose';
import { IAM_CONFIG, type IamConfig } from './iam.config.js';

/** Issues the tokens a session is made of. Checking an access token is the RBAC library's job. */
@Injectable()
export class TokenService {
    constructor(@Inject(IAM_CONFIG) private readonly config: IamConfig) {}

    signAccessToken(claims: AuthContext): Promise<string> {
        return new SignJWT(accessTokenPayload(claims))
            .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM })
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
