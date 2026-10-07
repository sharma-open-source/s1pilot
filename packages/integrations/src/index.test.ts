import { describe, expect, it } from 'vitest';

import { INTEGRATIONS_PACKAGE } from './index.js';

describe('@s1pilot/integrations', () => {
  it('loads', () => {
    expect(INTEGRATIONS_PACKAGE).toBe('@s1pilot/integrations');
  });
});
