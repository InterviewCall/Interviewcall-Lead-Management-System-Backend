import { timingSafeEqual } from 'node:crypto';
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenVerifier } from './access-token.verifier.js';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER } from './auth.constants.js';
import { ALLOW_PASSWORD_CHANGE_KEY } from './decorators/allow-password-change.decorator.js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator.js';
import { REQUIRE_CSRF_KEY } from './decorators/require-csrf.decorator.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import type { Role } from './roles.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Runs before every controller (registered globally by RbacModule). In order, a request must:
 *  1. be a @Public() route, or carry a valid access token cookie (401 otherwise). A public route
 *     marked @RequireCsrf() still gets step 2;
 *  2. if it changes data, send an X-CSRF-Token header equal to the crm_csrf cookie (403);
 *  3. not belong to an account that still has a temporary password, unless the route is
 *     marked @AllowPasswordChange() (403 PASSWORD_CHANGE_REQUIRED);
 *  4. come from a role listed in @Roles(...), if the route has one (403).
 * On success the caller is available as `request.auth`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly verifier: AccessTokenVerifier,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (context.getType() !== 'http') {
            return true;
        }

        const targets = [context.getHandler(), context.getClass()];
        const request = context.switchToHttp().getRequest<Request>();
        if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
            // A public route needs no session, but may still ask for the CSRF check.
            if (
                this.reflector.getAllAndOverride<boolean>(
                    REQUIRE_CSRF_KEY,
                    targets,
                )
            ) {
                this.requireCsrf(request);
            }
            return true;
        }

        const auth = await this.verifier.verify(
            request.cookies?.[ACCESS_COOKIE],
        );
        if (!auth) {
            throw new UnauthorizedException({
                code: 'UNAUTHENTICATED',
                message: 'Sign in to continue',
            });
        }

        this.requireCsrf(request);

        if (
            auth.mustChangePassword &&
            !this.reflector.getAllAndOverride<boolean>(
                ALLOW_PASSWORD_CHANGE_KEY,
                targets,
            )
        ) {
            throw new ForbiddenException({
                code: 'PASSWORD_CHANGE_REQUIRED',
                message: 'Choose a new password before continuing',
            });
        }

        const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
            ROLES_KEY,
            targets,
        );
        if (roles && !roles.includes(auth.role)) {
            throw new ForbiddenException({
                code: 'FORBIDDEN',
                message: 'You do not have access to this',
            });
        }

        request.auth = auth;
        return true;
    }

    /** Double-submit check: a page on another site cannot read the cookie to copy it into the header. */
    private requireCsrf(request: Request): void {
        if (SAFE_METHODS.has(request.method)) {
            return;
        }
        const header = request.get(CSRF_HEADER);
        const cookie: unknown = request.cookies?.[CSRF_COOKIE];
        if (
            !header ||
            typeof cookie !== 'string' ||
            !sameSecret(header, cookie)
        ) {
            throw new ForbiddenException({
                code: 'CSRF_INVALID',
                message:
                    'The request could not be verified. Reload the page and try again.',
            });
        }
    }
}

function sameSecret(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
