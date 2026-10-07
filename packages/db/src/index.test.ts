import { describe, expect, it } from 'vitest';

import { DB_PACKAGE } from './index.js';

describe('@s1pilot/db', () => {
  it('loads', () => {
    expect(DB_PACKAGE).toBe('@s1pilot/db');
  });
});
