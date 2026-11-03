import {
    createParamDecorator,
    type ExecutionContext,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../auth-context.js';

/** The signed-in user, set by the session guard. Not available on @Public() routes. */
export const CurrentUser = createParamDecorator(
    (_data: unknown, context: ExecutionContext): AuthContext => {
        const { auth } = context.switchToHttp().getRequest<Request>();
        if (!auth) {
            throw new UnauthorizedException({
                code: 'UNAUTHENTICATED',
                message: 'Sign in to continue',
            });
        }
        return auth;
    },
);
