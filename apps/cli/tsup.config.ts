import { defineConfig } from 'tsup';

/**
 * The packed CLI is self-contained: all `@s1pilot/*` workspace packages (private, never published) are bundled
 * into `dist/index.js`; third-party libraries stay regular `dependencies`.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Not cleaned: the copy step puts dist/web next to the bundle, and tests rebuild the bundle in place.
  clean: false,
  noExternal: [/^@s1pilot\//],
});
