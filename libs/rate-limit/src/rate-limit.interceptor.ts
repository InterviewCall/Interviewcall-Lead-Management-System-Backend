import {
    CallHandler,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { RATE_LIMIT_KEY, RATE_LIMIT_STORE } from './rate-limit.constants.js';
import type { RateLimitRule } from './rate-limit.decorator.js';
import type { RateLimitStore } from './rate-limit.store.js';

/**
 * Counts requests to routes marked @RateLimit(...). It runs after the guards, so it knows who is
 * signed in (and so a request the guard turns away is not counted), and before validation, so
 * malformed bodies count too. If the store fails the request goes through: the limiter is a
 * safety net, not a dependency.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
    private readonly logger = new Logger(RateLimitInterceptor.name);

    constructor(
        private readonly reflector: Reflector,
        @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    ) {}

    async intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Promise<Observable<unknown>> {
        if (context.getType() !== 'http') {
            return next.handle();
        }
        const rule = this.reflector.getAllAndOverride<
            RateLimitRule | undefined
        >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
        if (!rule) {
            return next.handle();
        }

        const http = context.switchToHttp();
        const request = http.getRequest<
            Request & { auth?: { publicId: string } }
        >();
        const subject = request.auth
            ? `user:${request.auth.publicId}`
            : `ip:${request.ip ?? 'unknown'}`;
        const route = `${context.getClass().name}.${context.getHandler().name}`;

        let hit;
        try {
            hit = await this.store.hit(
                `rl:${route}:${subject}`,
                rule.windowSeconds * 1000,
            );
        } catch (error) {
            this.logger.error(
                `Rate limit store failed, letting the request through: ${
                    error instanceof Error ? error.message : 'unknown error'
                }`,
            );
            return next.handle();
        }

        if (hit.count > rule.limit) {
            const seconds = Math.max(1, Math.ceil(hit.retryAfterMs / 1000));
            http.getResponse<Response>().setHeader(
                'Retry-After',
                String(seconds),
            );
            throw new HttpException(
                {
                    code: 'RATE_LIMITED',
                    message: `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
        return next.handle();
    }
}
