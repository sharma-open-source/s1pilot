import { readFileSync } from 'node:fs';

import { Command } from 'commander';

/** Reads the version from the root package.json (three levels above `dist/` or `src/`). */
export function getVersion(): string {
  const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/** Builds the `s1pilot` command tree. Only `--version` exists until S-022. */
export function buildProgram(): Command {
  return new Command('s1pilot').description('s1-pilot CLI').version(getVersion());
}
