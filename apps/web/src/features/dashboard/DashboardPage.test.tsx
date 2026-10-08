import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from './DashboardPage';

import { createFakeTrpc, FakeTrpcError, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

const SUMMARY = {
  passRate7d: 92.5,
  passRateSeries: [90, 95, null, 91, 93, 92, 94],
  runsToday: 7,
  runningNow: 1,
  needsReview: 4,
  flaky: 3,
  quarantined: 2,
  modeMix7d: { replay: 60, heal: 15, explore: 25 },
};

const PROJECTS = [
  {
    key: 'SHOP',
    name: 'Storefront',
    counts: { cases: 42, environments: 2 },
    lastRun: { id: 'r1', status: 'running', startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), summary: {} },
    s1Model: 'clef-flash',
    status: 'running',
  },
  { key: 'MAIL', name: 'Webmail', counts: { cases: 0, environments: 1 }, lastRun: null, s1Model: null, status: 'none' },
];

const summary = { passed: 0, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 };
const RECENT = [
  { id: 'r1', projectKey: 'SHOP', title: 'Smoke · SHOP', status: 'running', startedAt: null, summary, environment: 'staging', browsers: ['chromium'], mode: 'replay-heal', activeCaseSteps: 5 },
  { id: 'r2', projectKey: 'ADMIN', title: 'Regression · ADMIN', status: 'failed', startedAt: null, summary: { ...summary, failed: 3 }, environment: 'staging', browsers: ['chromium', 'firefox', 'webkit'], mode: 'replay-heal', activeCaseSteps: null },
  { id: 'r3', projectKey: 'SHOP', title: 'Checkout e2e · SHOP', status: 'needs-review', startedAt: null, summary: { ...summary, needsReview: 2 }, environment: 'staging', browsers: ['chromium'], mode: 'replay-heal', activeCaseSteps: null },
  { id: 'r4', projectKey: 'MAIL', title: 'Nightly · MAIL', status: 'passed', startedAt: null, summary: { ...summary, passed: 9 }, environment: 'dev', browsers: ['firefox'], mode: 'replay-only', activeCaseSteps: null },
];

function handlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'dashboard.summary': () => SUMMARY,
    'projects.list': () => PROJECTS,
    'runs.recent': () => RECENT,
    'environments.list': (i) =>
      (i as { projectKey: string }).projectKey === 'SHOP' ? [{ name: 'dev' }, { name: 'staging' }] : [{ name: 'dev' }],
    ...over,
  };
}

async function renderPage(over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc(handlers(over));
  const router = createRouter({
    routeTree: createRootRoute({ component: DashboardPage }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
  return fake;
}

class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  // Recharts' ResponsiveContainer needs it; jsdom has none.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('DashboardPage', () => {
  it('shows header actions, four tiles, projects, recent runs and the mode mix', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/projects/new');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Run a plan' })).toHaveAttribute('href', '/p/SHOP/plans'));
    expect(screen.getByLabelText('Search')).toBeInTheDocument();

    const metrics = await screen.findByRole('region', { name: 'Key metrics' });
    await within(metrics).findByText('92.5%');
    expect(within(metrics).getByText('7')).toBeInTheDocument();
    expect(within(metrics).getByText('1 running now', { exact: false })).toBeInTheDocument();
    expect(within(metrics).getByRole('link', { name: 'watch' })).toHaveAttribute('href', '/p/SHOP/runs/r1/live');
    expect(within(metrics).getByText('4')).toHaveClass('text-warning');
    expect(within(metrics).getByRole('link', { name: 'open queue' })).toHaveAttribute('href', '/p/SHOP/review');
    expect(within(metrics).getByText('Quarantined: 2')).toBeInTheDocument();

    const projects = screen.getByRole('region', { name: 'Projects' });
    const row = await within(projects).findByRole('row', { name: /SHOP · Storefront/ });
    expect(within(row).getByRole('link', { name: 'SHOP · Storefront' })).toHaveAttribute('href', '/p/SHOP/cases');
    await within(row).findByText('dev · staging');
    expect(within(row).getByText('clef-flash')).toBeInTheDocument();
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(within(row).getByText('2 h ago')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /MAIL · Webmail/ })).getByText('No runs')).toBeInTheDocument();

    const runs = screen.getByRole('region', { name: 'Recent runs' });
    const links = await within(runs).findAllByRole('link', { name: /· (SHOP|ADMIN|MAIL)/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/p/SHOP/runs/r1/live', '/p/ADMIN/runs/r2', '/p/SHOP/runs/r3', '/p/MAIL/runs/r4']);
    expect(within(links[1] as HTMLElement).getByText('staging · 3 browsers · 3 failed')).toBeInTheDocument();
    expect(within(links[2] as HTMLElement).getByText('staging · Chromium · 2 need review')).toBeInTheDocument();
    expect(within(links[3] as HTMLElement).getByText('dev · Firefox · replay mode')).toBeInTheDocument();
    expect(within(links[1] as HTMLElement).getByText('Failed')).toBeInTheDocument();
    expect(within(links[2] as HTMLElement).getByText('Review')).toBeInTheDocument();
    expect(within(links[3] as HTMLElement).getByText('Passed')).toBeInTheDocument();
  });

  it('sizes mode-mix segments to the API percentages', async () => {
    await renderPage();
    const bar = await screen.findByRole('img', { name: 'Replay 60%, Heal 15%, Explore 25%' });
    const width = (k: string) => (bar.querySelector(`[data-segment="${k}"]`) as HTMLElement).style.width;
    expect([width('replay'), width('heal'), width('explore')]).toEqual(['60%', '15%', '25%']);
    expect(screen.getByText(/Replay = no model call/)).toBeInTheDocument();
  });

  it('updates the running row to step x/y from the run socket and refetches on workspace messages', async () => {
    const fake = await renderPage();
    await screen.findByText('staging · Chromium · starting');
    const runSocket = FakeSocket.all.find((s) => s.url.endsWith('/ws/runs/r1'));
    expect(runSocket).toBeDefined();
    act(() => runSocket?.emit({ type: 'snapshot', steps: [{ stepIndex: 0 }, { stepIndex: 1 }] }));
    await screen.findByText('staging · Chromium · step 2/5');
    act(() => runSocket?.emit({ type: 'event', event: { type: 'step.started', stepIndex: 2 } }));
    await screen.findByText('staging · Chromium · step 3/5');
    expect(fake.calls.filter((c) => c.path === 'dashboard.summary')).toHaveLength(1);
  });

  it('shows the empty state without projects and runs', async () => {
    await renderPage({ 'projects.list': () => [], 'runs.recent': () => [], 'dashboard.summary': () => ({ ...SUMMARY, passRate7d: null, passRateSeries: Array(7).fill(null), modeMix7d: { replay: 0, heal: 0, explore: 0 } }) });
    expect(await screen.findByRole('link', { name: 'Create your first project' })).toHaveAttribute('href', '/projects/new');
    expect(screen.getByRole('link', { name: 'Run a plan' })).toHaveAttribute('href', '/projects/new');
    expect(await screen.findByText('No runs yet. Runs you start appear here.')).toBeInTheDocument();
    expect(await screen.findByText('No steps were executed in the last 7 days.')).toBeInTheDocument();
  });

  it('shows an error with retry when a query fails', async () => {
    await renderPage({
      'runs.recent': () => {
        throw new FakeTrpcError('boom', 'INTERNAL_SERVER_ERROR');
      },
    });
    const runs = screen.getByRole('region', { name: 'Recent runs' });
    expect(await within(runs).findByRole('alert')).toHaveTextContent('boom');
    await waitFor(() => expect(within(runs).getByRole('button', { name: 'Retry' })).toBeEnabled());
  });
});
