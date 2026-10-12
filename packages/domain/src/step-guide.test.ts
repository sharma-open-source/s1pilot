import { describe, expect, it } from 'vitest';

import { STEP_GUIDE, STEP_WRITING_RULES, stepGuidePrompt } from './step-guide.js';

describe('stepGuidePrompt', () => {
  it('contains every rule and every example of the guide', () => {
    const prompt = stepGuidePrompt();
    for (const rule of STEP_WRITING_RULES) expect(prompt).toContain(rule);
    for (const row of STEP_GUIDE.flatMap((g) => g.rows)) {
      for (const example of row.examples) expect(prompt).toContain(example);
    }
  });

  it('lists the test data keys (names only) when there are some, and asks for quoted examples otherwise', () => {
    const withKeys = stepGuidePrompt({ inputKeys: ['customer_password', 'email'] });
    expect(withKeys).toContain('Test data keys available: customer_password, email.');
    expect(withKeys).toMatch(/list the keys in the step's "inputs"/);
    const without = stepGuidePrompt({ inputKeys: [] });
    expect(without).toContain('No test data keys are defined');
    expect(without).not.toContain('Test data keys available');
  });
});
