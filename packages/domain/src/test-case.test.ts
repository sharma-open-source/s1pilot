import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { AssertionSchema, PrioritySchema, TestCaseFileSchema, TestCaseSchema } from './test-case.js';

describe('TestCaseFileSchema', () => {
  it('parses the plan §1.2 YAML example', () => {
    const raw = readFileSync(new URL('./fixtures/tc-042-guest-checkout.yaml', import.meta.url), 'utf8');
    const file = TestCaseFileSchema.parse(parse(raw));
    expect(file.key).toBe('SHOP-TC-42');
    expect(file.steps).toHaveLength(4);
    expect(file.preconditions).toEqual([{ flow: 'clear-cart' }]);
    expect(file.steps[1]?.assert[0]).toMatchObject({ type: 'elementText', role: 'status' });
    expect(file.steps[3]?.assert).toEqual([]);
  });

  it('applies defaults for optional fields', () => {
    const file = TestCaseFileSchema.parse({ key: 'SHOP-TC-1', title: 't', steps: [{ action: 'go' }] });
    expect(file).toMatchObject({ priority: 'P2', type: 'e2e', status: 'draft', tags: [] });
  });

  it('rejects an invalid priority readably', () => {
    const result = TestCaseFileSchema.safeParse({
      key: 'SHOP-TC-1',
      title: 't',
      priority: 'P9',
      steps: [{ action: 'go' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Expected 'P0' | 'P1' | 'P2' | 'P3'");
  });

  it('rejects empty steps', () => {
    expect(TestCaseFileSchema.safeParse({ key: 'K', title: 't', steps: [] }).success).toBe(false);
  });
});

describe('AssertionSchema', () => {
  it('accepts every assertion type', () => {
    const samples = [
      { type: 'urlMatches', pattern: '/x' },
      { type: 'titleContains', contains: 'Home' },
      { type: 'elementVisible', role: 'button', name: 'Buy' },
      { type: 'elementText', css: '.badge', equals: '1' },
      { type: 'elementValue', testId: 'zip', equals: '12345' },
      { type: 'elementCount', role: 'listitem', min: 1 },
      { type: 'responseStatus', urlPattern: '/api/cart', status: 200 },
      { type: 'noConsoleErrors' },
      { type: 'downloadExists' },
      { type: 'apiCheck', url: '/api/health', status: 200 },
      { type: 'ai', expected: 'The cart shows one item' },
    ];
    for (const sample of samples) expect(AssertionSchema.safeParse(sample).success).toBe(true);
  });

  it('rejects an unknown assertion type', () => {
    const result = AssertionSchema.safeParse({ type: 'magic' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Invalid discriminator value');
  });
});

describe('TestCaseSchema', () => {
  it('parses a persisted case', () => {
    const tc = TestCaseSchema.parse({
      id: 'c1',
      projectId: 'p1',
      key: 'SHOP-TC-1',
      title: 't',
      priority: 'P0',
      type: 'smoke',
      status: 'ready',
      steps: [{ action: 'go' }],
    });
    expect(tc.version).toBe(1);
    expect(PrioritySchema.safeParse('P4').success).toBe(false);
  });
});
