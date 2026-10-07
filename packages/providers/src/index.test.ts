import { describe, expect, it } from 'vitest';

import { PROVIDERS_PACKAGE } from './index.js';

describe('@s1pilot/providers', () => {
  it('loads', () => {
    expect(PROVIDERS_PACKAGE).toBe('@s1pilot/providers');
  });
});
