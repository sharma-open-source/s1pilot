import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.spec.ts'],
    environment: 'node',
    // One long scenario: servers start once, the steps share state and run in order.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    bail: 1,
  },
});
