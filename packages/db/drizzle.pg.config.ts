import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema-pg/index.ts',
  out: './migrations/pg',
  dbCredentials: { url: process.env['S1PILOT_DB_URL'] ?? 'postgres://localhost/s1pilot' },
});
