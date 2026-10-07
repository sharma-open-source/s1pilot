import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getVersion } from './index.js';

describe('@s1pilot/server', () => {
  it('reports the root package version', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(getVersion()).toBe(root.version);
  });
});
