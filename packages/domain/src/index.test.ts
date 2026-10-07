import { describe, expect, it } from 'vitest';

import { DOMAIN_PACKAGE } from './index.js';

describe('@s1pilot/domain', () => {
  it('loads', () => {
    expect(DOMAIN_PACKAGE).toBe('@s1pilot/domain');
  });
});
