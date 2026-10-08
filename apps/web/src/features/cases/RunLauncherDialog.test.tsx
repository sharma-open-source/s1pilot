import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RunLauncherDialog } from './RunLauncherDialog';

import { createFakeTrpc, FakeTrpcProvider } from '@/test/fake-trpc';

describe('RunLauncherDialog', () => {
  it('creates a run with mode, attended and build ref for the preselected cases', async () => {
    const user = userEvent.setup();
    const fake = createFakeTrpc({
      'environments.list': () => [
        { id: 'e1', name: 'dev' },
        { id: 'e2', name: 'staging' },
      ],
      'runs.create': () => ({ id: 'run-7' }),
    });
    const onStarted = vi.fn();
    render(
      <FakeTrpcProvider fake={fake}>
        <RunLauncherDialog open onOpenChange={() => undefined} projectKey="SHOP" caseKeys={['SHOP-TC-1', 'SHOP-TC-2']} defaultEnvironment="staging" onStarted={onStarted} />
      </FakeTrpcProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText('Environment')).toHaveValue('e2'));
    await user.click(screen.getByRole('button', { name: 'Remove SHOP-TC-2' }));
    await user.selectOptions(screen.getByLabelText('Mode'), 'explore');
    await user.click(screen.getByLabelText(/Attended/));
    await user.type(screen.getByLabelText('Build ref'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('run-7'));
    expect(fake.calls.find((c) => c.path === 'runs.create')?.input).toEqual({
      projectKey: 'SHOP',
      caseKeys: ['SHOP-TC-1'],
      environment: 'e2',
      browser: 'chromium',
      mode: 'explore',
      attended: true,
      buildRef: 'abc123',
    });
  });
});
