import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'libs/model/prisma/schema',
  migrations: {
    path: 'libs/model/prisma/migrations',
    seed: 'tsx libs/model/prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
