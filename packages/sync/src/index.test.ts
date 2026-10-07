import { describe, expect, it } from 'vitest';

import { SYNC_PACKAGE } from './index.js';

describe('@s1pilot/sync', () => {
  it('loads', () => {
    expect(SYNC_PACKAGE).toBe('@s1pilot/sync');
  });
});
