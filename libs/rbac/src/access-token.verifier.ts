import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { AuthContext } from './auth-context.js';
import {
    ACCESS_TOKEN_ALGORITHM,
    ACCESS_TOKEN_ISSUER,
    authContextFromPayload,
} from './access-token.js';

/** Injection token for the key access tokens are verified with. */
export const ACCESS_TOKEN_KEY = Symbol('ACCESS_TOKEN_KEY');

@Injectable()
export class AccessTokenVerifier {
    constructor(@Inject(ACCESS_TOKEN_KEY) private readonly key: Uint8Array) {}

    /** The caller a token names, or null if it is missing, forged, expired or malformed. */
    async verify(token: string | undefined): Promise<AuthContext | null> {
        if (!token) {
            return null;
        }
        try {
            const { payload } = await jwtVerify(token, this.key, {
                issuer: ACCESS_TOKEN_ISSUER,
                algorithms: [ACCESS_TOKEN_ALGORITHM],
            });
            return authContextFromPayload(payload);
        } catch {
            return null;
        }
    }
}
