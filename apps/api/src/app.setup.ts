import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';

/**
 * Settings that belong to the HTTP app itself. main.ts and the e2e tests both call this, so
 * the tests run against the real prefix and CORS rules.
 */
export function configureApp(app: INestApplication): void {
    // Behind a load balancer every request arrives from the balancer's address, which would give
    // all users one shared rate limit and one IP in the audit log. TRUST_PROXY is the number of
    // proxies in front of the app (1 for a single load balancer or nginx); unset means none.
    const hops = Number(process.env.TRUST_PROXY ?? 0);
    if (Number.isInteger(hops) && hops > 0) {
        app.getHttpAdapter().getInstance().set('trust proxy', hops);
    }
    // Everything is served under /api/v1; /health stays outside it for the deploy script.
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    // Makes the session cookies available as request.cookies.
    app.use(cookieParser());
    // Credentialed requests (the session cookies) are accepted only from the CRM web app.
    app.enableCors({
        origin: process.env.CRM_WEB_ORIGIN ?? false,
        credentials: true,
    });
}
