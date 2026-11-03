import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { loadAccessTokenSecret } from './access-token.js';
import {
    ACCESS_TOKEN_KEY,
    AccessTokenVerifier,
} from './access-token.verifier.js';
import { SessionGuard } from './session.guard.js';

/**
 * Import once in an API's root module. From then on every route in that API needs a staff
 * session, CSRF header and (optionally) a role, unless it is marked @Public().
 * It only verifies tokens. Issuing them (login) stays in the iam module of the API that owns users.
 */
@Module({
    providers: [
        {
            provide: ACCESS_TOKEN_KEY,
            useFactory: () => loadAccessTokenSecret(),
        },
        AccessTokenVerifier,
        { provide: APP_GUARD, useClass: SessionGuard },
    ],
    exports: [AccessTokenVerifier],
})
export class RbacModule {}
