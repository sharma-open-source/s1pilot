import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STATUS_PILLS, StatusPill, statusPillFor } from './pill';

describe('StatusPill mapping (design.md 2.2)', () => {
  const expected: Record<string, [string, string]> = {
    running: ['Running', 'running'],
    'in-progress': ['In progress', 'running'],
    passed: ['Passed', 'success'],
    valid: ['Valid', 'success'],
    connected: ['Connected', 'success'],
    failed: ['Failed', 'danger'],
    abort: ['Failed', 'danger'],
    critical: ['Failed', 'danger'],
    'needs-review': ['Review', 'warning'],
    'heal-pending': ['Review', 'warning'],
    expired: ['Review', 'warning'],
    flaky: ['Flaky', 'flaky'],
    blocked: ['Blocked', 'neutral'],
    skipped: ['Skipped', 'neutral'],
    'not-run': ['Blocked', 'neutral'],
    draft: ['Draft', 'draft'],
    queued: ['Queued', 'queued'],
    'to-do': ['To do', 'queued'],
  };

  it('covers every status in the table, nothing more', () => {
    expect(Object.keys(STATUS_PILLS).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s -> %j', (status, [label, tone]) => {
    expect(statusPillFor(status)).toEqual({ label, tone });
  });

  it('renders text (never colour alone)', () => {
    render(<StatusPill status="needs-review" />);
    expect(screen.getByText('Review')).toHaveAttribute('data-status', 'needs-review');
  });

  it('falls back to a neutral pill for unknown statuses', () => {
    expect(statusPillFor('weird')).toEqual({ label: 'weird', tone: 'neutral' });
  });
});
