import {
    BadRequestException,
    StandardSchemaValidationPipe,
    type StandardSchemaValidationPipeOptions,
} from '@nestjs/common';

type Issues = Parameters<
    NonNullable<StandardSchemaValidationPipeOptions['exceptionFactory']>
>[0];

/**
 * Turns schema issues into the API error shape: { code, message, fields? }.
 * `fields` maps a dotted field path to the first message for that field. The message comes from
 * the schema, never from the submitted value, so nothing personal is echoed back.
 */
export function validationException(issues: Issues): BadRequestException {
    const fields: Record<string, string> = {};
    let message: string | undefined;

    for (const issue of issues) {
        const path = (issue.path ?? [])
            .map((segment) =>
                String(typeof segment === 'object' ? segment.key : segment),
            )
            .join('.');
        if (path === '') {
            message ??= issue.message;
        } else {
            fields[path] ??= issue.message;
        }
    }

    return new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: message ?? 'Some fields are invalid',
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
    });
}

/**
 * Validates every `@Body({ schema })`, `@Query({ schema })` and `@Param({ schema })` against its
 * schema and hands the controller the parsed value. Registered once, globally, in AppModule.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
    return new StandardSchemaValidationPipe({
        exceptionFactory: validationException,
    });
}
