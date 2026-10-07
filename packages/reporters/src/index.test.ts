import { describe, expect, it } from 'vitest';

import { REPORTERS_PACKAGE } from './index.js';

describe('@s1pilot/reporters', () => {
  it('loads', () => {
    expect(REPORTERS_PACKAGE).toBe('@s1pilot/reporters');
  });
});
