import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildProgram, getVersion } from './program.js';

describe('@s1pilot/cli', () => {
  it('exposes the root package version', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(getVersion()).toBe(root.version);
    expect(buildProgram().version()).toBe(root.version);
  });
});
