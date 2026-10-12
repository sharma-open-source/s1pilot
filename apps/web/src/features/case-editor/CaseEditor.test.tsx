import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CaseEditorPage } from './CaseEditorPage';

import { createFakeTrpc, FakeTrpcError, FakeTrpcProvider, type FakeTrpc, type Handler } from '@/test/fake-trpc';

vi.mock('./monaco', () => ({ loadMonaco: () => Promise.reject(new Error('no monaco in jsdom')) }));

interface StoredCase {
  id: string;
  key: string;
  version: number;
  title: string;
  priority: string;
  type: string;
  status: string;
  tags: string[];
  requirements: string[];
  preconditions: Array<Record<string, string>>;
  parameters: Array<Record<string, string>>;
  steps: Array<Record<string, unknown>>;
}

const STEP = (action: string, extra: Record<string, unknown> = {}) => ({ action, assert: [], inputs: [], ...extra });

function makeCase(over: Partial<StoredCase> = {}): StoredCase {
  return {
    id: 'c1',
    key: 'SHOP-TC-42',
    version: 3,
    title: 'Guest can check out a single item',
    priority: 'P1',
    type: 'e2e',
    status: 'ready',
    tags: ['checkout', 'guest'],
    requirements: ['SHOP-REQ-7'],
    preconditions: [{ flow: 'clear-cart' }, { auth: 'none (guest)' }],
    parameters: [
      { colour: 'blue', size: 'M' },
      { colour: 'black', size: 'L' },
    ],
    steps: [
      STEP('Search for "t-shirt" and open the "Classic Tee" product', { expected: 'The product page for Classic Tee is shown' }),
      STEP('Choose colour {colour} and size {size}, then add to cart', {
        expected: 'Cart badge shows 1 item',
        assert: [{ type: 'elementText', testId: 'status', contains: '1' }],
      }),
      STEP('Go to checkout as guest and fill the shipping form', { inputs: ['shipping_name', 'shipping_zip'], assert: [{ type: 'urlMatches', pattern: '/checkout/payment' }] }),
    ],
    ...over,
  };
}

interface Setup {
  fake: FakeTrpc;
  store: { current: StoredCase };
  navigate: ReturnType<typeof vi.fn>;
  router: ReturnType<typeof makeRouter>;
}

const callsTo = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

function makeRouter(navigate: (to: string) => void, initial: string) {
  function Page() {
    const p = useParams({ strict: false }) as { key: string; caseKey: string; tab?: string };
    return <CaseEditorPage projectKey={p.key} caseKey={p.caseKey} tab={p.tab} navigate={navigate} />;
  }
  const root = createRootRoute({ component: Outlet });
  const tab = createRoute({ getParentRoute: () => root, path: '/p/$key/cases/$caseKey/$tab', component: Page });
  const other = createRoute({ getParentRoute: () => root, path: '/other', component: () => <p>Other page</p> });
  return createRouter({ routeTree: root.addChildren([tab, other]), history: createMemoryHistory({ initialEntries: [initial] }) });
}

function setup(over: Record<string, Handler> = {}, tab = 'steps', initial?: Partial<StoredCase>): Setup {
  const store = { current: makeCase(initial) };
  const handlers: Record<string, Handler> = {
    'cases.get': () => ({
      ...store.current,
      suitePath: [
        { id: 's1', name: 'Checkout' },
        { id: 's2', name: 'Guest' },
      ],
      learned: [
        { environmentId: 'e1', environmentName: 'staging', status: 'current', caseVersion: 3, healCount: 0, pendingProposals: 0 },
        { environmentId: 'e2', environmentName: 'dev', status: 'none' },
      ],
      lastResult: null,
    }),
    'environments.list': () => [
      { id: 'e1', name: 'staging', baseUrl: 'http://x' },
      { id: 'e2', name: 'dev', baseUrl: 'http://y' },
    ],
    'sharedSteps.list': () => [{ id: 'f1', name: 'Login', params: ['user'], steps: [STEP('Log in as {user}')], usageCount: 4 }],
    'requirements.list': () => [
      { key: 'SHOP-REQ-7', title: 'Guest checkout', caseKeys: ['SHOP-TC-42'], coverage: 1 },
      { key: 'SHOP-REQ-8', title: 'Coupons', caseKeys: [], coverage: 0 },
    ],
    'cases.update': (i) => {
      const input = i as { expectedVersion: number; patch: Partial<StoredCase> };
      if (input.expectedVersion !== store.current.version) throw new FakeTrpcError('stale', 'CONFLICT');
      store.current = { ...store.current, ...input.patch, version: store.current.version + 1 };
      return store.current;
    },
    'runs.create': () => ({ id: 'run-9' }),
    ...over,
  };
  const fake = createFakeTrpc(handlers);
  const navigate = vi.fn();
  const router = makeRouter(navigate, `/p/SHOP/cases/SHOP-TC-42/${tab}`);
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, store, navigate, router };
}

describe('CaseEditorPage', () => {
  it('renders the wireframe sections', async () => {
    setup();
    expect(await screen.findByLabelText('Title')).toHaveValue('Guest can check out a single item');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs).toHaveTextContent('Test cases/Checkout/Guest/SHOP-TC-42 · v3');
    const tabs = screen.getByRole('navigation', { name: 'Case sections' });
    expect(within(tabs).getAllByRole('link').map((l) => l.textContent)).toEqual(['Steps', 'Parameters · 2', 'Learned script', 'YAML', 'History', 'Results']);
    expect(screen.getByText('flow: clear-cart')).toBeInTheDocument();
    expect(screen.getByText('auth: none (guest)')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Test steps' })).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['#', 'Action (plain language)', 'Expected result', 'Checks', 'Row actions']);
    expect(screen.getByLabelText('Action of step 1')).toHaveValue('Search for "t-shirt" and open the "Classic Tee" product');
    expect(screen.getAllByText('AI check').length).toBe(2);
    expect(screen.getByText('text(status) ⊇ "1"')).toBeInTheDocument();
    expect(screen.getByText('url ~ /checkout/payment')).toBeInTheDocument();
    expect(screen.getByLabelText('Inputs of step 3')).toHaveValue('shipping_name, shipping_zip');
    for (const name of ['+ Add step', '+ Insert shared step']) expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record steps from here' })).toBeEnabled();
    const aside = screen.getByRole('complementary', { name: 'Case details' });
    expect(within(aside).getByLabelText('Priority')).toHaveValue('P1');
    expect(within(aside).getByText('checkout')).toBeInTheDocument();
    expect(within(aside).getByText('SHOP-REQ-7')).toBeInTheDocument();
    expect(within(aside).getByText('Next run replays without model calls; S1 heals only changed steps.')).toBeInTheDocument();
    expect(within(aside).getByText('Ready · 3/3 steps')).toBeInTheDocument();
    expect(within(aside).getByText('Not learned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves edits with expectedVersion and bumps the version in the breadcrumb', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    const action = await screen.findByLabelText('Action of step 1');
    await user.type(action, ' now');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('SHOP-TC-42 · v4'));
    const update = callsTo(fake, 'cases.update')[0]?.input as { key: string; expectedVersion: number; patch: { steps: Array<{ action: string }> } };
    expect(update.key).toBe('SHOP-TC-42');
    expect(update.expectedVersion).toBe(3);
    expect(update.patch.steps[0]?.action).toBe('Search for "t-shirt" and open the "Classic Tee" product now');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('saves with Ctrl+S', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    await user.type(await screen.findByLabelText('Title'), '!');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(callsTo(fake, 'cases.update')).toHaveLength(1));
  });

  it('adds, duplicates, deletes and reorders steps', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Action of step 1');
    await user.click(screen.getByRole('button', { name: '+ Add step' }));
    expect(screen.getByLabelText('Action of step 4')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Duplicate step 1' }));
    expect(screen.getByLabelText('Action of step 2')).toHaveValue('Search for "t-shirt" and open the "Classic Tee" product');
    await user.click(screen.getByRole('button', { name: 'Delete step 2' }));
    expect(screen.getByLabelText('Action of step 2')).toHaveValue('Choose colour {colour} and size {size}, then add to cart');
    const handle = screen.getByRole('button', { name: /^Reorder step 1/ });
    handle.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByLabelText('Action of step 2')).toHaveValue('Search for "t-shirt" and open the "Classic Tee" product');
  });

  it('suggests parameters after { and inserts the chip', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Action of step 1');
    await user.click(screen.getByRole('button', { name: '+ Add step' }));
    const field = screen.getByLabelText('Action of step 4');
    await user.type(field, 'Pick {{si');
    const list = await screen.findByRole('listbox', { name: 'Parameters' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['{size}']);
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Action of step 4')).toHaveValue('Pick {size}');
  });

  it('converts a step to a shared step with @ autocomplete', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Action of step 1');
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Add step' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '+ Add step' }));
    await user.type(screen.getByLabelText('Action of step 4'), '@Log');
    await user.click(await screen.findByRole('option', { name: /Login/ }));
    expect(await screen.findByText('Shared step')).toBeInTheDocument();
    expect(screen.getByLabelText('Argument user of step 4')).toBeInTheDocument();
  });

  it('inserts a shared step from the picker with usage counts', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Action of step 1');
    await user.click(screen.getByRole('button', { name: '+ Insert shared step' }));
    const dialog = await screen.findByRole('dialog', { name: 'Insert shared step' });
    expect(await within(dialog).findByText(/used in 4 cases/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Login/ }));
    expect(await screen.findByText('Shared step')).toBeInTheDocument();
  });

  it('builds an assertion whose tag equals summarizeAssertion', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    await screen.findByLabelText('Action of step 1');
    await user.click(screen.getByRole('button', { name: 'Add check to step 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add check' });
    await user.selectOptions(within(dialog).getByLabelText('Check type'), 'elementText');
    await user.type(within(dialog).getByLabelText('Test id'), 'status');
    await user.type(within(dialog).getByLabelText('Contains'), '2');
    expect(within(dialog).getByTestId('assertion-preview')).toHaveTextContent('text(status) ⊇ "2"');
    await user.click(within(dialog).getByRole('button', { name: 'Add check' }));
    const row = screen.getByTestId('step-row-1');
    expect(within(row).getByText('text(status) ⊇ "2"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo(fake, 'cases.update')).toHaveLength(1));
    const patch = (callsTo(fake, 'cases.update')[0]?.input as { patch: { steps: Array<{ assert: unknown[] }> } }).patch;
    expect(patch.steps[0]?.assert).toEqual([{ type: 'elementText', testId: 'status', contains: '2' }]);
  });

  it('shows validation for the assertion builder', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Action of step 1');
    await user.click(screen.getByRole('button', { name: 'Add check to step 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add check' });
    await user.click(within(dialog).getByRole('button', { name: 'Add check' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('URL pattern is required');
  });

  it('edits parameters in the Parameters tab', async () => {
    const user = userEvent.setup();
    const { fake } = setup({}, 'parameters');
    const cell = await screen.findByLabelText('colour, row 1');
    await user.clear(cell);
    await user.type(cell, 'red');
    await user.click(screen.getByRole('button', { name: '+ Add row' }));
    expect(screen.getByLabelText('size, row 3')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New parameter'), 'qty');
    await user.click(screen.getByRole('button', { name: '+ Add parameter' }));
    expect(screen.getByLabelText('qty, row 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo(fake, 'cases.update')).toHaveLength(1));
    const params = (callsTo(fake, 'cases.update')[0]?.input as { patch: { parameters: unknown[] } }).patch.parameters;
    expect(params).toEqual([
      { colour: 'red', size: 'M', qty: '' },
      { colour: 'black', size: 'L', qty: '' },
      { colour: '', size: '', qty: '' },
    ]);
  });

  it('shows the learned script state per environment', async () => {
    setup({}, 'learned');
    expect(await screen.findByRole('region', { name: 'Learned script for staging' })).toHaveTextContent('Ready · 3/3 steps');
    expect(screen.getByRole('region', { name: 'Learned script for dev' })).toHaveTextContent('Not learned');
    expect(screen.getAllByRole('button', { name: 'Forget script' })[0]).toBeDisabled();
  });

  it('opens a conflict dialog on a stale save; Overwrite re-saves against the newer version', async () => {
    const user = userEvent.setup();
    const { fake, store } = setup();
    await user.type(await screen.findByLabelText('Action of step 1'), ' mine');
    // someone else saves first
    store.current = { ...store.current, version: 4, steps: [STEP('Totally different first step'), ...store.current.steps.slice(1)] };
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'This case was changed elsewhere' });
    expect(dialog).toHaveTextContent('now v4');
    const diff = within(dialog).getByLabelText('Differences');
    expect(within(diff).getByText(/Totally different first step/).closest('[data-diff]')).toHaveAttribute('data-diff', 'remove');
    expect(within(diff).getByText(/Classic Tee" product mine/).closest('[data-diff]')).toHaveAttribute('data-diff', 'add');
    await user.click(within(dialog).getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('v5'));
    const updates = callsTo(fake, 'cases.update').map((c) => (c.input as { expectedVersion: number }).expectedVersion);
    expect(updates).toEqual([3, 4]);
    expect(store.current.steps[0]?.['action']).toContain('mine');
  });

  it('Reload in the conflict dialog discards edits and shows the saved version', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await user.type(await screen.findByLabelText('Action of step 1'), ' mine');
    store.current = { ...store.current, version: 4, steps: [STEP('Server first step'), ...store.current.steps.slice(1)] };
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'This case was changed elsewhere' });
    await user.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText('Action of step 1')).toHaveValue('Server first step'));
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('v4');
  });

  it('round-trips YAML edits into the Steps tab', async () => {
    const user = userEvent.setup();
    const yamlText = 'key: SHOP-TC-42\ntitle: Guest\nsteps:\n  - action: Old step\n';
    const { fake, store } = setup(
      {
        'cases.yaml': () => ({ key: 'SHOP-TC-42', version: store.current.version, yaml: yamlText }),
        'cases.updateFromYaml': (i) => {
          const input = i as { yaml: string; expectedVersion: number };
          expect(input.expectedVersion).toBe(3);
          store.current = { ...store.current, version: 4, steps: [STEP('Step from YAML')] };
          return store.current;
        },
      },
      'yaml',
    );
    const editor = await screen.findByLabelText('Case YAML');
    expect(editor).toHaveValue(yamlText);
    fireInput(editor, 'key: SHOP-TC-42\ntitle: Guest\nsteps:\n  - action: Step from YAML\n');
    await user.click(screen.getByRole('button', { name: 'Apply YAML' }));
    await waitFor(() => expect(callsTo(fake, 'cases.updateFromYaml')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('v4'));
    await user.click(within(screen.getByRole('navigation', { name: 'Case sections' })).getByRole('link', { name: 'Steps' }));
    expect(await screen.findByLabelText('Action of step 1')).toHaveValue('Step from YAML');
    expect(screen.queryByLabelText('Action of step 2')).not.toBeInTheDocument();
  });

  it('reports YAML syntax errors with line numbers and blocks apply', async () => {
    setup({ 'cases.yaml': () => ({ key: 'SHOP-TC-42', version: 3, yaml: 'key: a\nsteps: []\n' }) }, 'yaml');
    const editor = await screen.findByLabelText('Case YAML');
    fireInput(editor, 'key: a\nsteps: [\n');
    expect(await screen.findByText(/Line \d+, column \d+/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply YAML' })).toBeDisabled();
  });

  it('lists versions and a side-by-side step diff in History', async () => {
    const before = STEP('Old action');
    const after = STEP('New action');
    setup(
      {
        'cases.history': () => [
          { ...makeCase(), version: 3, steps: [after], updatedAt: '2026-10-08T10:00:00.000Z' },
          { ...makeCase(), version: 2, steps: [before], updatedAt: '2026-10-07T10:00:00.000Z' },
        ],
        'cases.diff': () => ({ key: 'SHOP-TC-42', fromVersion: 2, toVersion: 3, unified: '', steps: [{ index: 0, change: 'changed', before, after }] }),
      },
      'history',
    );
    expect(await screen.findByLabelText('Versions')).toBeInTheDocument();
    expect(await screen.findByText('Old action')).toBeInTheDocument();
    expect(screen.getByText('New action')).toBeInTheDocument();
    expect(screen.getByText('changed')).toBeInTheDocument();
  });

  it('lists the case results in the Results tab', async () => {
    setup(
      {
        'runs.list': () => [{ id: 'run-aaaaaaaa-1', status: 'passed', config: { environment: 'staging', browser: 'chromium' } }],
        'runs.get': () => ({
          id: 'run-aaaaaaaa-1',
          config: { environment: 'staging', browser: 'chromium' },
          results: [
            { id: 'r1', key: 'SHOP-TC-42', verdict: 'passed', caseVersion: 3, mode: 'replay', durationMs: 4200 },
            { id: 'r2', key: 'SHOP-TC-1', verdict: 'failed', caseVersion: 1, mode: 'replay', durationMs: 100 },
          ],
        }),
      },
      'results',
    );
    expect(await screen.findByText('run-aaaa')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: /Last results/ })).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('4.2 s')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
  });

  it('asks before leaving with unsaved changes', async () => {
    const user = userEvent.setup();
    const { router } = setup();
    await user.type(await screen.findByLabelText('Title'), '!');
    void router.navigate({ to: '/other' as never });
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    void router.navigate({ to: '/other' as never });
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByText('Other page')).toBeInTheDocument();
  });

  it('does not block switching tabs or leaving a clean editor', async () => {
    const user = userEvent.setup();
    const { router } = setup();
    await screen.findByLabelText('Title');
    await user.click(within(screen.getByRole('navigation', { name: 'Case sections' })).getByRole('link', { name: /Parameters/ }));
    expect(await screen.findByRole('region', { name: 'Parameters' })).toBeInTheDocument();
    void router.navigate({ to: '/other' as never });
    expect(await screen.findByText('Other page')).toBeInTheDocument();
  });

  it('Delete confirms, deletes the case and returns to the list without the unsaved-changes prompt', async () => {
    const user = userEvent.setup();
    const { fake, navigate } = setup({ 'cases.bulk': () => ({ action: 'delete', affected: 1, keys: ['SHOP-TC-42'] }) });
    await user.type(await screen.findByLabelText('Title'), '!');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete SHOP-TC-42?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete case' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/SHOP/cases'));
    expect(callsTo(fake, 'cases.bulk')[0]?.input).toEqual({ ids: ['c1'], action: 'delete' });
    expect(callsTo(fake, 'cases.update')).toHaveLength(0);
  });

  it('Run now saves first, then starts an attended run and opens the live view', async () => {
    const user = userEvent.setup();
    const { fake, navigate } = setup();
    await user.type(await screen.findByLabelText('Title'), '!');
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/SHOP/runs/run-9/live'));
    const order = fake.calls.map((c) => c.path).filter((p) => p === 'cases.update' || p === 'runs.create');
    expect(order).toEqual(['cases.update', 'runs.create']);
    expect(callsTo(fake, 'runs.create')[0]?.input).toEqual({
      projectKey: 'SHOP',
      caseKeys: ['SHOP-TC-42'],
      environment: 'staging',
      browser: 'chromium',
      attended: true,
    });
  });

  it('refuses to save a step without an action', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    await screen.findByLabelText('Action of step 1');
    await user.click(screen.getByRole('button', { name: '+ Add step' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Step 4 has no action.');
    expect(callsTo(fake, 'cases.update')).toHaveLength(0);
  });

  it('shows an error state for an unknown case', async () => {
    setup({ 'cases.get': () => { throw new FakeTrpcError('Case not found: SHOP-TC-42', 'NOT_FOUND'); } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Case not found');
  });
});

/** Sets a controlled textarea value the way a paste would (user-event `type` is slow for multi-line YAML). */
function fireInput(el: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
