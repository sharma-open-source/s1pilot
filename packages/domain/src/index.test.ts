import { describe, expect, it } from 'vitest';

import * as domain from './index.js';

describe('@s1pilot/domain', () => {
  it('re-exports schemas, errors and helpers', () => {
    expect(domain.ProjectSchema).toBeDefined();
    expect(domain.TestCaseFileSchema).toBeDefined();
    expect(domain.RunEventSchema).toBeDefined();
    expect(domain.S1PilotError).toBeDefined();
    expect(domain.createLogger).toBeTypeOf('function');
    expect(domain.newId).toBeTypeOf('function');
  });
});
