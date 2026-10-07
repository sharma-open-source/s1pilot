import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env['S1PILOT_DB_URL'] ?? '../../.s1pilot/data.db' },
});
