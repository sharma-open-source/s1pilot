import { readFileSync } from 'node:fs';

/**
 * Reads the version from the root package.json (three levels above `dist/` or `src/`).
 * Placeholder until the API server lands (S-031).
 */
export function getVersion(): string {
  const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}
