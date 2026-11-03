import type { INestApplication } from '@nestjs/common';

/**
 * Settings that belong to the HTTP app itself. main.ts and the e2e tests both call this, so
 * the tests run against the real prefix and CORS rules.
 */
export function configureApp(app: INestApplication): void {
    // Everything is served under /api/v1; /health stays outside it for the deploy script.
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    // Credentialed requests (the session cookies) are accepted only from the CRM web app.
    app.enableCors({
        origin: process.env.CRM_WEB_ORIGIN ?? false,
        credentials: true,
    });
}
