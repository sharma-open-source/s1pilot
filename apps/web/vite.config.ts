import { fileURLToPath } from 'node:url';

import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const SERVER = process.env['S1PILOT_SERVER_URL'] ?? 'http://127.0.0.1:5317';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: false }), react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/trpc': SERVER,
      '/api': SERVER,
      '/ws': { target: SERVER, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    // Browser suites each start a Vite dev server + Chromium; keep startup within budget when the whole repo tests in parallel.
    hookTimeout: 120_000,
    poolOptions: { forks: { minForks: 1, maxForks: 3 } },
  },
});
