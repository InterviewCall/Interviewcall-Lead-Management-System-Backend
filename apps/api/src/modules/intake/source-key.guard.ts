import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { type SourceIdentity, SourceKeyService } from '@modules/iam';
import { INTAKE_KEY_HEADER } from './intake.constants.js';

export type SourceRequest = Request & { source?: SourceIdentity };

/** Lets a request through when it carries an active source key. The route says @Public(), so no staff session is asked for. */
@Injectable()
export class SourceKeyGuard implements CanActivate {
    constructor(private readonly keys: SourceKeyService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<SourceRequest>();
        const header = request.headers[INTAKE_KEY_HEADER];
        const identity = await this.keys.verify(Array.isArray(header) ? header[0] : header);
        if (!identity) {
            throw new UnauthorizedException({
                code: 'INVALID_SOURCE_KEY',
                message: 'The intake key is missing, wrong or revoked',
            });
        }
        request.source = identity;
        return true;
    }
}
