import { readFileSync } from 'node:fs';

/**
 * Reads the version from the nearest package.json: the package's own one (one level above `dist/` or `src/`,
 * also when bundled into the packed CLI) or, in the monorepo, the root one (three levels above).
 */
export function getVersion(): string {
  for (const path of ['../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}
