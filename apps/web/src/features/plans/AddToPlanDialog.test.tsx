import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AddToPlanDialog } from './AddToPlanDialog';

import { createFakeTrpc, FakeTrpcProvider } from '@/test/fake-trpc';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const plan = (id: string, name: string, kind: 'list' | 'query') => ({
  id,
  name,
  selection: kind === 'list' ? { kind, caseIds: ['c1'] } : { kind, query: 'tags:x' },
  lastRun: null,
});

function setup() {
  const fake = createFakeTrpc({
    'plans.list': () => [plan('p-manual', 'Hand picked', 'list'), plan('p-query', 'By query', 'query')],
    'environments.list': () => [{ id: 'e1', name: 'staging', readOnly: false, browsers: [] }],
    'plans.update': () => ({}),
    'plans.create': (i) => ({ id: 'p-new', name: (i as { name: string }).name }),
  });
  const onDone = vi.fn();
  render(
    <FakeTrpcProvider fake={fake}>
      <AddToPlanDialog projectKey="SHOP" open onOpenChange={() => undefined} caseIds={['c1', 'c2']} onDone={onDone} />
    </FakeTrpcProvider>,
  );
  return { fake, onDone };
}

describe('AddToPlanDialog', () => {
  it('only offers hand-picked plans and merges the selection into the chosen one', async () => {
    const user = userEvent.setup();
    const { fake, onDone } = setup();
    const select = await screen.findByLabelText('Plan');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Hand picked' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'By query' })).not.toBeInTheDocument();
    await user.selectOptions(select, 'p-manual');
    await user.click(screen.getByRole('button', { name: 'Add to plan' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fake.calls.find((c) => c.path === 'plans.update')?.input).toEqual({ id: 'p-manual', patch: { selection: { kind: 'list', caseIds: ['c1', 'c2'] } } });
  });

  it('creates a new manual plan', async () => {
    const user = userEvent.setup();
    const { fake, onDone } = setup();
    await user.type(await screen.findByLabelText('New plan name'), 'Smoke');
    await waitFor(() => expect(fake.calls.some((c) => c.path === 'environments.list')).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Add to plan' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Created plan Smoke with 2 cases', 'p-new'));
    expect(fake.calls.find((c) => c.path === 'plans.create')?.input).toMatchObject({ name: 'Smoke', selection: { kind: 'list', caseIds: ['c1', 'c2'] } });
  });
});
