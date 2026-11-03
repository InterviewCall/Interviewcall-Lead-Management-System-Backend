import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    Logger,
} from '@nestjs/common';
import type { Response } from 'express';

export interface ApiError {
    code: string;
    message: string;
    fields?: Record<string, string>;
}

const CODE_BY_STATUS: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    422: 'UNPROCESSABLE',
    423: 'LOCKED',
    429: 'TOO_MANY_REQUESTS',
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Builds { code, message, fields? } from whatever an HttpException carries. */
export function toApiError(
    status: number,
    response: unknown,
    fallbackMessage: string,
): ApiError {
    if (
        isRecord(response) &&
        typeof response.code === 'string' &&
        typeof response.message === 'string'
    ) {
        const fields = isRecord(response.fields)
            ? (response.fields as Record<string, string>)
            : undefined;
        return {
            code: response.code,
            message: response.message,
            ...(fields ? { fields } : {}),
        };
    }

    const message =
        typeof response === 'string'
            ? response
            : isRecord(response) && typeof response.message === 'string'
              ? response.message
              : fallbackMessage;

    return { code: CODE_BY_STATUS[status] ?? `HTTP_${status}`, message };
}

/**
 * Every error leaves the API as { code, message, fields? }. Anything that is not an
 * HttpException is logged here and answered with a generic 500 so internals never leak.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger('Api');

    catch(exception: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>();

        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            response
                .status(status)
                .json(
                    toApiError(
                        status,
                        exception.getResponse(),
                        exception.message,
                    ),
                );
            return;
        }

        this.logger.error(
            exception instanceof Error
                ? (exception.stack ?? exception.message)
                : String(exception),
        );
        response.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Something went wrong',
        } satisfies ApiError);
    }
}
