import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
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
    },
    include: ['**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
  },
});
