import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { hbsAsText } from './vitest.hbs-plugin.js';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths(), hbsAsText()],
  test: {
    globals: true,
    root: './',
    setupFiles: ['dotenv/config'],
    // Tests never depend on a developer's .env.
    env: {
      ACCESS_TOKEN_SECRET: 'test-only-secret-test-only-secret-0000',
      // Building the Prisma client opens no connection; these only satisfy the env checks.
      DB_HOST: 'localhost',
      DB_USER: 'test',
      DB_PASSWORD: 'test',
      DB_NAME: 'test',
      // Nothing connects to Redis or SES in tests; these only satisfy the settings checks.
      REDIS_URL: 'redis://localhost:6379',
      AWS_REGION: 'ap-south-1',
      EMAIL_FROM: 'InterviewCall CRM <crm@example.com>',
    },
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
  },
});
