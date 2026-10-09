import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { PlanBuilderPage } from './PlanBuilderPage';
import { PlansListPage } from './PlansListPage';

import { createQueryClient, createTrpcClient, trpc } from '@/lib/trpc';
import { createFakeTrpc, FakeTrpcError, type FakeTrpc, type Handler } from '@/test/fake-trpc';

const ENVS = [
  { id: 'e-stg', projectId: 'p1', name: 'staging', baseUrl: 'https://stg', readOnly: false, browsers: [{ browser: 'chromium' }] },
  { id: 'e-dev', projectId: 'p1', name: 'dev', baseUrl: 'https://dev', readOnly: false, browsers: [{ browser: 'chromium' }] },
  { id: 'e-prod', projectId: 'p1', name: 'prod', baseUrl: 'https://prod', readOnly: true, browsers: [{ browser: 'chromium' }] },
];

const CASES = [
  { id: 'c1', key: 'SHOP-TC-1', title: 'Guest checkout', priority: 'P0' },
  { id: 'c2', key: 'SHOP-TC-2', title: 'Coupon', priority: 'P1' },
];

type Store = { plans: Array<Record<string, unknown>> };

function makeHandlers(store: Store): Record<string, Handler> {
  return {
    'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 2, environments: 3 }, lastRun: null, s1Model: null, status: 'none' }],
    'environments.list': () => ENVS,
    'plans.list': () => store.plans.map((p) => ({ ...p, lastRun: p['id'] === 'plan1' ? { id: 'run-abcdef123456', status: 'passed', startedAt: new Date().toISOString(), summary: {} } : null })),
    'plans.get': (id) => {
      const p = store.plans.find((x) => x['id'] === id);
      if (!p) throw new FakeTrpcError('Plan not found', 'NOT_FOUND');
      return { ...p, lastRun: null };
    },
    'plans.create': (input) => {
      const { projectKey: _k, ...draft } = input as Record<string, unknown>;
      void _k;
      const p = { id: 'plan-new', projectId: 'p1', ...draft };
      store.plans.push(p);
      return p;
    },
    'plans.update': (input) => {
      const { id, patch } = input as { id: string; patch: Record<string, unknown> };
      const i = store.plans.findIndex((x) => x['id'] === id);
      store.plans[i] = { ...store.plans[i], ...patch };
      return store.plans[i];
    },
    'triggers.get': (id) => ({ planId: id, token: 'tok123', webhookPath: `/api/hooks/plans/${String(id)}/tok123`, timezone: null, effectiveTimezone: 'UTC', skipIfRunning: true }),
    'plans.preview': (input) => {
      const i = input as { selection: { kind: string; query?: string; caseIds?: string[] }; matrix: unknown[]; parallelism: number };
      if (i.selection.kind === 'query' && i.selection.query?.includes('((')) throw new FakeTrpcError('Unbalanced parenthesis at position 1', 'BAD_REQUEST');
      const matched = i.selection.kind === 'list' ? (i.selection.caseIds ?? []).length : 2;
      return {
        matched,
        learned: 1,
        notLearned: Math.max(0, matched - 1),
        quarantined: 0,
        executions: matched * i.matrix.length,
        estimateMin: 1.5,
        jobs: matched * i.matrix.length,
        combos: i.matrix.map((m, n) => ({ environmentId: (m as { environmentId: string }).environmentId, environmentName: `c${n}`, browser: 'chromium' })),
        skippedCombos: [],
        cases: CASES.filter((c) => i.selection.kind === 'list' && (i.selection.caseIds ?? []).includes(c.id)),
      };
    },
    'runs.create': () => ({ id: 'run-1', status: 'queued' }),
    'cases.list': () => ({ items: CASES.map((c) => ({ ...c, status: 'ready' })), total: 2 }),
  };
}

function renderAt(path: string, store: Store, over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc({ ...makeHandlers(store), ...over });
  const queryClient = createQueryClient();
  const client = createTrpcClient(fake.fetch);
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/p/$key/plans', component: () => <PlansListPage projectKey="SHOP" /> }),
    createRoute({ getParentRoute: () => root, path: '/p/$key/plans/$planId', component: function R() { return <PlanBuilderPage projectKey="SHOP" planId={router.state.location.pathname.split('/').pop() ?? 'new'} />; } }),
    createRoute({ getParentRoute: () => root, path: '/p/$key/runs/$runId/live', component: () => <div>live view</div> }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  function Wrapper() {
    const [c] = useState(() => client);
    return (
      <trpc.Provider client={c} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </trpc.Provider>
    );
  }
  render(<Wrapper />);
  return { fake, router };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const calls = (fake: FakeTrpc, path: string) => fake.calls.filter((c) => c.path === path);

const SAVED = {
  id: 'plan1',
  projectId: 'p1',
  name: 'Checkout regression',
  release: '2.4',
  selection: { kind: 'query', query: 'suite:Checkout AND priority<=P2' },
  matrix: [
    { environmentId: 'e-stg', browser: 'chromium' },
    { environmentId: 'e-stg', browser: 'webkit', device: 'iPhone 13' },
  ],
  retries: 2,
  parallelism: 3,
  mode: 'explore',
  unattended: 'pause',
  schedule: '0 2 * * 1-5',
  exitCriteria: [{ kind: 'p0-passed', params: { percent: 100 } }],
  checks: { a11y: true, consoleErrors: false, visual: false, video: true },
};

describe('PlanBuilderPage', () => {
  it('restores every saved field', async () => {
    renderAt('/p/SHOP/plans/plan1', { plans: [SAVED] });
    expect(await screen.findByLabelText('Plan name')).toHaveValue('Checkout regression');
    expect(screen.getByLabelText('Release')).toHaveValue('2.4');
    expect(screen.getByLabelText('Query')).toHaveValue('suite:Checkout AND priority<=P2');
    expect(screen.getByLabelText('staging Chromium')).toBeChecked();
    expect(screen.getByLabelText('staging Mobile')).toBeChecked();
    expect(screen.getByLabelText('Mobile device')).toHaveValue('iPhone 13');
    expect(screen.getByLabelText('Mode')).toHaveValue('explore');
    expect(screen.getByLabelText('Retries on failure')).toHaveValue(2);
    expect(screen.getByLabelText('Parallel workers')).toHaveValue(3);
    expect(screen.getByLabelText('Unattended escalations')).toHaveValue('pause');
    expect(screen.getByLabelText('Accessibility scan (axe)')).toBeChecked();
    expect(screen.getByLabelText('Fail on console errors')).not.toBeChecked();
    expect(screen.getByLabelText('Record video')).toBeChecked();
    expect(screen.getByLabelText('Visual comparison (later)')).toBeDisabled();
    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 2 * * 1-5');
    expect(screen.getByText('At 02:00, Mon–Fri')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '100% of P0 cases passed' })).toBeInTheDocument();
    expect(await screen.findByText(/\/api\/hooks\/plans\/plan1\/tok123/)).toBeInTheDocument();
    expect(await screen.findByText('2 cases match')).toBeInTheDocument();
  });

  it('disables browsers a read-only environment does not allow', async () => {
    renderAt('/p/SHOP/plans/new', { plans: [] });
    await screen.findByLabelText('Plan name');
    expect(screen.getByText('read-only')).toBeInTheDocument();
    expect(screen.getByLabelText('prod Chromium')).toBeEnabled();
    expect(screen.getByLabelText('prod Firefox')).toBeDisabled();
    expect(screen.getByLabelText('prod WebKit')).toBeDisabled();
    expect(screen.getByLabelText('prod Mobile')).toBeDisabled();
  });

  it('updates preview chips within 500 ms of a query edit and shows syntax errors inline', async () => {
    const user = userEvent.setup();
    const { fake } = renderAt('/p/SHOP/plans/new', { plans: [] });
    const q = await screen.findByLabelText('Query');
    await user.type(q, 'priority<=P1');
    await waitFor(() => expect(calls(fake, 'plans.preview').length).toBeGreaterThan(0), { timeout: 1000 });
    expect(await screen.findByText('2 cases match')).toBeInTheDocument();
    expect(screen.getByText('1 learned · replay')).toBeInTheDocument();
    expect(screen.getByText('1 not learned · explore (slower)')).toBeInTheDocument();
    expect(screen.getByText('0 quarantined · excluded')).toBeInTheDocument();

    const t0 = performance.now();
    await user.clear(q);
    await user.type(q, '((');
    const alert = await screen.findByText('Unbalanced parenthesis at position 1', undefined, { timeout: 1000 });
    expect(performance.now() - t0).toBeLessThan(500 + 150);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(q).toHaveAttribute('aria-invalid', 'true');
  });

  it('validates, creates a plan and Run plan now starts a run with the previewed expansion', async () => {
    const user = userEvent.setup();
    const store: Store = { plans: [] };
    const { fake, router } = renderAt('/p/SHOP/plans/new', store);
    await user.click(await screen.findByRole('button', { name: 'Save plan' }));
    expect(await screen.findByText('Give the plan a name')).toBeInTheDocument();
    expect(calls(fake, 'plans.create')).toHaveLength(0);

    await user.type(screen.getByLabelText('Plan name'), 'Smoke');
    await user.type(screen.getByLabelText('Query'), 'tags:smoke');
    await user.click(screen.getByLabelText('dev Firefox'));
    await user.click(screen.getByLabelText('Schedule'));
    await user.clear(screen.getByLabelText('Cron expression'));
    await user.type(screen.getByLabelText('Cron expression'), '30 6 * * *');
    expect(screen.getByText('At 06:30, every day')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Add criterion' }));
    await user.click(await screen.findByRole('menuitem', { name: 'No open defects ≥ severity' }));
    await screen.findByText('2 cases match');
    const estimate = await screen.findByTestId('estimate-executions');
    await waitFor(() => expect(estimate).toHaveTextContent('2 cases × 2 combos = 4 executions'));

    await user.click(screen.getByRole('button', { name: 'Run plan now' }));
    await waitFor(() => expect(calls(fake, 'runs.create')).toHaveLength(1));
    const created = calls(fake, 'plans.create')[0]?.input as Record<string, unknown>;
    expect(created).toMatchObject({
      projectKey: 'SHOP',
      name: 'Smoke',
      selection: { kind: 'query', query: 'tags:smoke' },
      schedule: '30 6 * * *',
      retries: 1,
      parallelism: 4,
      exitCriteria: [{ kind: 'no-open-defects', params: { severity: 'S2' } }],
    });
    expect(created['matrix']).toHaveLength(2);
    expect(calls(fake, 'runs.create')[0]?.input).toMatchObject({ projectKey: 'SHOP', planId: 'plan-new' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/p/SHOP/runs/run-1/live'));
  });

  it('saves edits of an existing plan, clearing the schedule when it is switched off', async () => {
    const user = userEvent.setup();
    const store: Store = { plans: [SAVED] };
    const { fake } = renderAt('/p/SHOP/plans/plan1', store);
    await screen.findByLabelText('Plan name');
    await user.click(screen.getByLabelText('Schedule'));
    await user.clear(screen.getByLabelText('Retries on failure'));
    await user.type(screen.getByLabelText('Retries on failure'), '3');
    await user.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(calls(fake, 'plans.update')).toHaveLength(1));
    const upd = calls(fake, 'plans.update')[0]?.input as { id: string; patch: Record<string, unknown> };
    expect(upd.id).toBe('plan1');
    expect(upd.patch).toMatchObject({ retries: 3, schedule: '', release: '2.4' });
    expect(await screen.findByRole('status')).toHaveTextContent('Plan saved');
  });

  it('picks cases manually through the dialog', async () => {
    const user = userEvent.setup();
    const { fake } = renderAt('/p/SHOP/plans/new', { plans: [] });
    await user.click(await screen.findByRole('button', { name: 'Pick manually' }));
    await user.click(screen.getByRole('button', { name: '+ Pick cases' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByLabelText('Pick SHOP-TC-1'));
    await user.click(within(dialog).getByRole('button', { name: 'Use 1 case' }));
    expect(await screen.findByText('1 case selected')).toBeInTheDocument();
    expect(await screen.findByText('Guest checkout')).toBeInTheDocument();
    await waitFor(() => expect(calls(fake, 'plans.preview').some((c) => JSON.stringify(c.input).includes('"caseIds":["c1"]'))).toBe(true));
  });
});

describe('PlansListPage', () => {
  it('lists plans with release, cases, matrix, schedule and last run', async () => {
    renderAt('/p/SHOP/plans', { plans: [SAVED] });
    const link = await screen.findByRole('link', { name: 'Checkout regression' });
    expect(link).toHaveAttribute('href', '/p/SHOP/plans/plan1');
    const row = link.closest('tr') as HTMLElement;
    expect(within(row).getByText('2.4')).toBeInTheDocument();
    expect(within(row).getByText(/query · suite:Checkout/)).toBeInTheDocument();
    expect(within(row).getByText('2 combos · staging')).toBeInTheDocument();
    expect(within(row).getByText('At 02:00, Mon–Fri')).toBeInTheDocument();
    expect(await within(row).findByText('Passed')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    renderAt('/p/SHOP/plans', { plans: [] });
    expect(await screen.findByText(/No test plans yet/)).toBeInTheDocument();
  });
});
