import { describe, expect, it } from 'vitest';

import { ENGINE_DOMAIN, ENGINE_PACKAGE } from './index.js';

describe('@s1pilot/engine', () => {
  it('loads and links @s1pilot/domain', () => {
    expect(ENGINE_PACKAGE).toBe('@s1pilot/engine');
    expect(ENGINE_DOMAIN).toBe('@s1pilot/domain');
  });
});
