import { defineConfig } from 'prisma/config';

// Inject DATABASE_URL for migration commands. Generation requires no credentials.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
