import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { SharedStepEditorPage } from './SharedStepEditorPage';
import { SharedStepsPage } from './SharedStepsPage';

import { createFakeTrpc, FakeTrpcError, FakeTrpcProvider, type FakeTrpc, type Handler } from '@/test/fake-trpc';

interface Flow {
  id: string;
  projectId: string;
  name: string;
  params: string[];
  steps: Array<Record<string, unknown>>;
  usage: { steps: string[]; preconditions: string[]; flows: string[]; logins: string[] };
}

const STEP = (action: string, extra: Record<string, unknown> = {}) => ({ action, assert: [], inputs: [], ...extra });
const NO_USE = { steps: [], preconditions: [], flows: [], logins: [] };

const FLOWS = (): Flow[] => [
  { id: 'f1', projectId: 'p1', name: 'Log in as role', params: ['role'], steps: [STEP('Open the login page'), STEP('Log in as {role}', { expected: 'Hello {role}' })], usage: { steps: ['SHOP-TC-1'], preconditions: ['SHOP-TC-2'], flows: ['fresh-start'], logins: ['staging / admin'] } },
  { id: 'f2', projectId: 'p1', name: 'clear-cart', params: [], steps: [STEP('Empty the cart')], usage: NO_USE },
];

function setup(path: string, over: Record<string, Handler> = {}) {
  const store = { flows: FLOWS() };
  const row = (f: Flow) => ({ ...f, usageCount: new Set([...f.usage.steps, ...f.usage.preconditions]).size });
  const fake = createFakeTrpc({
    'sharedSteps.list': () => store.flows.map(row),
    'sharedSteps.get': (i) => {
      const f = store.flows.find((x) => x.id === (i as { id: string }).id);
      if (!f) throw new FakeTrpcError('Shared step not found', 'NOT_FOUND');
      return { ...row(f), usedBy: [...f.usage.steps, ...f.usage.preconditions] };
    },
    'sharedSteps.create': (i) => {
      const f: Flow = { id: 'f9', projectId: 'p1', usage: NO_USE, ...(i as { name: string; params: string[]; steps: Flow['steps'] }) };
      store.flows.push(f);
      return f;
    },
    'sharedSteps.update': (i) => {
      const input = i as Partial<Flow> & { id: string };
      const f = store.flows.find((x) => x.id === input.id) as Flow;
      Object.assign(f, input);
      return f;
    },
    'sharedSteps.delete': (i) => {
      const id = (i as { id: string }).id;
      store.flows = store.flows.filter((f) => f.id !== id);
      return { id, name: 'x' };
    },
    ...over,
  });
  const navigate = vi.fn();
  function Editor() {
    const p = useParams({ strict: false }) as { key: string; id: string };
    return <SharedStepEditorPage projectKey={p.key} id={p.id} navigate={navigate} />;
  }
  const root = createRootRoute({ component: Outlet });
  const listRoute = createRoute({ getParentRoute: () => root, path: '/p/$key/library/shared-steps', component: () => <SharedStepsPage projectKey="SHOP" /> });
  const editRoute = createRoute({ getParentRoute: () => root, path: '/p/$key/library/shared-steps/$id', component: Editor });
  const router = createRouter({ routeTree: root.addChildren([listRoute, editRoute]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, store, navigate };
}

const calls = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('SharedStepsPage', () => {
  it('lists shared steps with parameters, steps and usage', async () => {
    setup('/p/SHOP/library/shared-steps');
    const row = (await screen.findByRole('link', { name: 'Log in as role' })).closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Log in as role' })).toHaveAttribute('href', '/p/SHOP/library/shared-steps/f1');
    expect(row).toHaveTextContent('{role}');
    expect(row).toHaveTextContent('Open the login page → Log in as {role}');
    expect(row).toHaveTextContent('2 cases · 1 shared step · 1 login');
    expect(screen.getByRole('link', { name: 'New shared step' })).toHaveAttribute('href', '/p/SHOP/library/shared-steps/new');
    expect(screen.getByText('2 shared steps')).toBeInTheDocument();
  });

  it('refuses to delete a used shared step and deletes an unused one after confirmation', async () => {
    const user = userEvent.setup();
    const { fake } = setup('/p/SHOP/library/shared-steps');
    await user.click(await screen.findByRole('button', { name: 'Delete Log in as role' }));
    const blocked = await screen.findByRole('dialog', { name: '“Log in as role” is still used' });
    expect(within(blocked).getByText('SHOP-TC-1')).toBeInTheDocument();
    expect(within(blocked).getByText('staging / admin')).toBeInTheDocument();
    await user.click(within(blocked).getByRole('button', { name: 'Close' }));
    expect(calls(fake, 'sharedSteps.delete')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete clear-cart' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete “clear-cart”?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete shared step' }));
    await waitFor(() => expect(calls(fake, 'sharedSteps.delete')[0]?.input).toEqual({ id: 'f2' }));
    expect(await screen.findByText('Deleted “clear-cart”')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'clear-cart' })).toBeNull());
  });

  it('shows an empty state that explains shared steps', async () => {
    setup('/p/SHOP/library/shared-steps', { 'sharedSteps.list': () => [] });
    expect(await screen.findByText(/No shared steps yet/)).toBeInTheDocument();
  });
});

describe('SharedStepEditorPage', () => {
  it('creates a shared step with parameters and opens it', async () => {
    const user = userEvent.setup();
    const { fake, navigate } = setup('/p/SHOP/library/shared-steps/new');
    await user.click(await screen.findByRole('button', { name: 'Create shared step' }));
    expect(screen.getByText('Give the shared step a name.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Add item to cart');
    await user.type(screen.getByLabelText('Parameters (optional)'), 'product, two words');
    await user.type(screen.getByLabelText('Action of step 1'), 'Open {{product}');
    await user.click(screen.getByRole('button', { name: 'Create shared step' }));
    expect(screen.getByText(/"two words" is not a valid parameter name/)).toBeInTheDocument();
    const params = screen.getByLabelText('Parameters (optional)');
    await user.clear(params);
    await user.type(params, 'product, qty');
    expect(screen.getByText('Not used in any step: {qty}.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create shared step' }));
    await waitFor(() =>
      expect(calls(fake, 'sharedSteps.create')[0]?.input).toEqual({
        projectKey: 'SHOP',
        name: 'Add item to cart',
        params: ['product', 'qty'],
        steps: [{ action: 'Open {product}', assert: [], inputs: [] }],
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/p/SHOP/library/shared-steps/f9');
    expect(screen.queryByRole('button', { name: 'Record steps from here' })).toBeNull();
  });

  it('edits an existing shared step, shows where it is used and saves', async () => {
    const user = userEvent.setup();
    const { fake } = setup('/p/SHOP/library/shared-steps/f1');
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Log in as role');
    expect(screen.getByLabelText('Parameters (optional)')).toHaveValue('role');
    expect(screen.getByLabelText('Action of step 2')).toHaveValue('Log in as {role}');
    const used = screen.getByRole('region', { name: 'Used by' });
    expect(within(used).getByRole('link', { name: 'SHOP-TC-1' })).toHaveAttribute('href', '/p/SHOP/cases/SHOP-TC-1');
    expect(within(used).getByText('staging / admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'Sign in as role');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fake, 'sharedSteps.update')[0]?.input).toMatchObject({ id: 'f1', name: 'Sign in as role', params: ['role'] }));
    expect(await screen.findByText('Saved. References to “Log in as role” now use “Sign in as role”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows server errors such as a cycle', async () => {
    const user = userEvent.setup();
    setup('/p/SHOP/library/shared-steps/f2', { 'sharedSteps.update': () => { throw new FakeTrpcError('"clear-cart" would include itself (clear-cart → fresh-start → clear-cart)', 'BAD_REQUEST'); } });
    await user.type(await screen.findByLabelText('Action of step 1'), ' now');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/would include itself/)).toBeInTheDocument();
  });

  it('deletes an unused shared step and returns to the list', async () => {
    const user = userEvent.setup();
    const { fake, navigate } = setup('/p/SHOP/library/shared-steps/f2');
    await screen.findByLabelText('Name');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete shared step' }));
    await waitFor(() => expect(calls(fake, 'sharedSteps.delete')[0]?.input).toEqual({ id: 'f2' }));
    expect(navigate).toHaveBeenCalledWith('/p/SHOP/library/shared-steps');
  });
});
