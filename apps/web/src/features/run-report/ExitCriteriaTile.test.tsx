import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ExitCriteriaTile } from './ExitCriteriaTile';

const CRITERIA = {
  met: 2,
  total: 4,
  items: [
    { label: '≥ 100% of P0 passed', met: false, actual: '50%', detail: '1 of 2 passed.' },
    { label: 'Review queue empty', met: false, actual: '1 pending', detail: '1 item(s) wait for review.' },
    { label: 'No open defects ≥ S2', met: true, actual: '0 open', detail: 'No matching open defects.' },
    { label: '≥ 95% of P1/P2 passed', met: true, actual: '100%', detail: '2 of 2 passed.' },
  ],
};

describe('ExitCriteriaTile', () => {
  it('shows "2 of 4 not met" and expands the criteria list', async () => {
    render(<ExitCriteriaTile criteria={CRITERIA} signOff={{ by: 'local', at: '2026-10-09T10:00:00.000Z', note: 'Ship it' }} />);
    expect(screen.getByText('2 of 4 not met')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Exit criteria' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show criteria' }));
    expect(screen.getAllByText('Not met')).toHaveLength(2);
    expect(screen.getByText('≥ 100% of P0 passed')).toBeInTheDocument();
    expect(screen.getByText(/Signed off by/)).toBeInTheDocument();
  });

  it('renders a dash when the run has no criteria', () => {
    render(<ExitCriteriaTile criteria={null} />);
    expect(screen.getByText('–')).toBeInTheDocument();
  });
});
