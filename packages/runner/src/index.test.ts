import { describe, expect, it } from 'vitest';

import { RUNNER_PACKAGE } from './index.js';

describe('@s1pilot/runner', () => {
  it('loads', () => {
    expect(RUNNER_PACKAGE).toBe('@s1pilot/runner');
  });
});
