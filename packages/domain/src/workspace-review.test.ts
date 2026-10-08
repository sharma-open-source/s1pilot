import { describe, expect, it } from 'vitest';

import { HealProposalSchema, ReviewItemSchema } from './review.js';
import { SuiteSchema, TestDataSetSchema, WorkspaceSchema } from './workspace.js';

describe('workspace, suite and data set', () => {
  it('parses with defaults', () => {
    expect(WorkspaceSchema.parse({ id: 'w1', name: 'Acme' }).name).toBe('Acme');
    expect(SuiteSchema.parse({ id: 's1', projectId: 'p1', name: 'Checkout' }).position).toBe(0);
    expect(TestDataSetSchema.parse({ id: 'd1', projectId: 'p1', name: 'users' }).rows).toEqual([]);
  });

  it('rejects empty names', () => {
    expect(SuiteSchema.safeParse({ id: 's1', projectId: 'p1', name: '' }).success).toBe(false);
  });
});

describe('review items and heal proposals', () => {
  it('parses with pending status by default', () => {
    expect(ReviewItemSchema.parse({ id: 'r1', projectId: 'p1', kind: 'heal', refId: 'h1' }).status).toBe('pending');
    expect(HealProposalSchema.parse({ id: 'h1', caseId: 'c1', environmentId: 'e1', runId: 'r1', stepIndex: 0, before: [], after: [], confidence: 0.9 }).status).toBe('pending');
  });

  it('rejects unknown kinds and statuses', () => {
    expect(ReviewItemSchema.safeParse({ id: 'r1', projectId: 'p1', kind: 'other', refId: 'x' }).success).toBe(false);
    expect(ReviewItemSchema.safeParse({ id: 'r1', projectId: 'p1', kind: 'heal', refId: 'x', status: 'maybe' }).success).toBe(false);
  });
});
