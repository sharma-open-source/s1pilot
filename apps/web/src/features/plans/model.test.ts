import { describe, expect, it } from 'vitest';

import { blankForm, cellChecked, changeDevice, criterionText, describeCron, entryAllowed, formFromPlan, toDraft, toggleCell, validateForm, type PlanEnv } from './model';

const staging: PlanEnv = { id: 'e1', name: 'staging', readOnly: false, browsers: [{ browser: 'chromium' }] };
const prod: PlanEnv = { id: 'e3', name: 'prod', readOnly: true, browsers: [{ browser: 'chromium' }] };
const envs: PlanEnv[] = [staging, prod];

describe('describeCron', () => {
  it('describes weekday and daily schedules', () => {
    expect(describeCron('0 2 * * 1-5')).toEqual({ valid: true, text: 'At 02:00, Mon–Fri' });
    expect(describeCron('30 14 * * *').text).toBe('At 14:30, every day');
    expect(describeCron('0 9 * * 1,3').text).toBe('At 09:00, Mon, Wed');
    expect(describeCron('*/5 * * * *')).toEqual({ valid: true, text: 'Custom schedule' });
  });
  it('rejects malformed expressions', () => {
    expect(describeCron('nope').valid).toBe(false);
    expect(describeCron('0 2 * *').valid).toBe(false);
    expect(describeCron('').valid).toBe(false);
  });
});

describe('matrix helpers', () => {
  it('toggles cells and re-points mobile entries', () => {
    let m = toggleCell([], 'e1', 'chromium', 'Pixel 7');
    m = toggleCell(m, 'e1', 'mobile', 'Pixel 7');
    expect(cellChecked(m, 'e1', 'mobile', 'Pixel 7')).toBe(true);
    m = changeDevice(m, 'iPhone 13');
    expect(m).toContainEqual({ environmentId: 'e1', browser: 'webkit', device: 'iPhone 13' });
    expect(cellChecked(m, 'e1', 'mobile', 'iPhone 13')).toBe(true);
    m = toggleCell(m, 'e1', 'chromium', 'iPhone 13');
    expect(m).toHaveLength(1);
  });
  it('restricts read-only environments to their listed browsers', () => {
    expect(entryAllowed(prod, { environmentId: 'e3', browser: 'chromium' })).toBe(true);
    expect(entryAllowed(prod, { environmentId: 'e3', browser: 'firefox' })).toBe(false);
    expect(entryAllowed(staging, { environmentId: 'e1', browser: 'firefox' })).toBe(true);
  });
});

describe('form <-> plan', () => {
  it('round-trips every field', () => {
    const f = {
      ...blankForm(envs),
      name: 'Checkout regression',
      release: '2.4',
      query: 'suite:Checkout',
      retries: 2,
      parallelism: 3,
      mode: 'explore' as const,
      unattended: 'pause' as const,
      scheduleOn: true,
      cron: '0 2 * * 1-5',
      exitCriteria: [{ kind: 'p0-passed', params: { percent: 100 } }],
      checks: { a11y: true, consoleErrors: false, visual: false, video: true },
    };
    const draft = toDraft(f);
    const back = formFromPlan({ id: 'p1', ...draft });
    expect(toDraft(back)).toEqual(draft);
    expect(back.scheduleOn).toBe(true);
  });
  it('omits schedule when off and validates', () => {
    const f = { ...blankForm(envs), name: 'x', query: 'a' };
    expect(toDraft(f)).not.toHaveProperty('schedule');
    expect(validateForm(f)).toEqual({});
    expect(validateForm({ ...f, name: ' ', query: '', matrix: [] })).toMatchObject({ name: expect.any(String), query: expect.any(String), matrix: expect.any(String) });
  });
  it('texts for criteria', () => {
    expect(criterionText({ kind: 'pass-rate', params: { percent: 90 } })).toBe('≥ 90% of P1–P2 passed');
    expect(criterionText({ kind: 'no-open-defects', params: { severity: 'S1' } })).toBe('No open defects ≥ S1');
  });
});
