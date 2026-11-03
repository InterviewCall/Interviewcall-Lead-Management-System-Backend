import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    // Everything is served under /api/v1; /health stays outside it for the deploy script.
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
