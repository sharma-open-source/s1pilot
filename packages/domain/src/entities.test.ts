import { describe, expect, it } from 'vitest';

import { DefectSchema } from './defect.js';
import { LearnedScriptSchema } from './learned-script.js';
import { TestPlanSchema } from './plan.js';
import { RequirementSchema } from './requirement.js';
import { CaseResultSchema, StepResultSchema, TestRunSchema } from './run.js';
import { SharedStepSchema } from './shared-step.js';

describe('plan', () => {
  const matrix = [{ environmentId: 'e1', browser: 'chromium' }];

  it('parses list and query selections with defaults', () => {
    const plan = TestPlanSchema.parse({
      id: 'pl1',
      projectId: 'p1',
      name: 'Smoke',
      selection: { kind: 'query', query: 'tags:smoke AND priority<=P1' },
      matrix,
    });
    expect(plan).toMatchObject({ retries: 0, parallelism: 1, mode: 'replay-heal', unattended: 'block' });
    expect(plan.checks.a11y).toBe(false);
    expect(
      TestPlanSchema.safeParse({ id: 'a', projectId: 'p', name: 'n', selection: { kind: 'list', caseIds: ['c1'] }, matrix })
        .success,
    ).toBe(true);
  });

  it('rejects an empty matrix and an unknown selection kind', () => {
    const base = { id: 'a', projectId: 'p', name: 'n', selection: { kind: 'list', caseIds: [] } };
    expect(TestPlanSchema.safeParse({ ...base, matrix: [] }).success).toBe(false);
    expect(TestPlanSchema.safeParse({ ...base, selection: { kind: 'x' }, matrix }).success).toBe(false);
  });
});

describe('run entities', () => {
  it('parses a run, case result and step result', () => {
    expect(TestRunSchema.parse({ id: 'r1', projectId: 'p1', trigger: 'ci', status: 'queued' }).summary.passed).toBe(0);
    expect(
      CaseResultSchema.safeParse({
        id: 'cr1', runId: 'r1', caseId: 'c1', caseVersion: 1, verdict: 'needs-review', durationMs: 10, mode: 'healed',
      }).success,
    ).toBe(true);
    expect(StepResultSchema.parse({ id: 's1', caseResultId: 'cr1', stepIndex: 0, status: 'passed' }).decisions).toEqual([]);
  });

  it('rejects an unknown verdict', () => {
    const result = CaseResultSchema.safeParse({
      id: 'cr1', runId: 'r1', caseId: 'c1', caseVersion: 1, verdict: 'ok', durationMs: 1, mode: 'replay',
    });
    expect(result.success).toBe(false);
  });
});

describe('learned script', () => {
  it('parses resolved actions with locator candidates', () => {
    const script = LearnedScriptSchema.parse({
      id: 'ls1',
      caseId: 'c1',
      caseVersion: 2,
      environmentId: 'e1',
      createdFromRunId: 'r1',
      actions: [
        {
          stepIndex: 0,
          subIndex: 0,
          action: 'fill',
          locators: [{ kind: 'role', value: 'textbox', name: 'Email' }, { kind: 'css', value: '#email' }],
          valueRef: 'var:email',
          fingerprint: 'abc123',
          fromRunId: 'r1',
        },
      ],
    });
    expect(script.health.healCount).toBe(0);
  });

  it('rejects an unknown locator kind', () => {
    expect(
      LearnedScriptSchema.safeParse({
        id: 'ls1', caseId: 'c1', caseVersion: 1, environmentId: 'e1', createdFromRunId: 'r1',
        actions: [{ stepIndex: 0, subIndex: 0, action: 'click', locators: [{ kind: 'xpath', value: '//a' }], fingerprint: 'f', fromRunId: 'r1' }],
      }).success,
    ).toBe(false);
  });
});

describe('shared step, defect, requirement', () => {
  it('parses each', () => {
    expect(SharedStepSchema.parse({ id: 's', projectId: 'p', name: 'Log in as {role}', params: ['role'], steps: [{ action: 'log in' }] }).params).toEqual(['role']);
    expect(DefectSchema.parse({ id: 'd1', projectId: 'p', title: 'Cart broken', severity: 'S2' }).status).toBe('open');
    expect(RequirementSchema.parse({ id: 'q1', projectId: 'p', key: 'SHOP-REQ-7', title: 'Guest checkout' }).caseIds).toEqual([]);
  });

  it('rejects bad severity and empty shared steps', () => {
    expect(DefectSchema.safeParse({ id: 'd', projectId: 'p', title: 't', severity: 'S9' }).success).toBe(false);
    expect(SharedStepSchema.safeParse({ id: 's', projectId: 'p', name: 'n', steps: [] }).success).toBe(false);
  });
});
