import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AnalyticsPage, PassRateChart, SuiteBars } from './AnalyticsPage';
import { dayLabel, formatDuration, formatPct, parseSearch, parseView, toCsv, type AnalyticsSearch, type AnalyticsView } from './model';

import { createFakeTrpc, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

const SERIES = {
  environments: ['dev', 'staging'],
  total: 120,
  points: [
    { day: '2026-10-07', rates: { dev: 90, staging: null } },
    { day: '2026-10-08', rates: { dev: 80, staging: 100 } },
    { day: '2026-10-09', rates: { dev: 85.5, staging: 95 } },
  ],
};
const BY_SUITE = [
  { suiteId: 's1', suite: 'Auth', passed: 9, review: 0, failed: 1, flaky: 0, total: 10 },
  { suiteId: 's2', suite: 'Search', passed: 8, review: 1, failed: 1, flaky: 1, total: 10 },
];
const AI = {
  model: 'clef-flash',
  decisions: 500,
  escalationRate: 12.5,
  needsReviewRate: 8,
  overrideRate: 30,
  ece: 0.123,
  reviewedDecisions: 42,
  latencyP50: 180,
  latencyP95: 1200,
  healSuccessRate: 75,
  lastTunedAt: null,
};
const READY = [
  {
    planId: 'p1',
    plan: 'Release 1.4',
    release: '1.4',
    run: { id: 'run1', status: 'failed', startedAt: '2026-10-09T10:00:00.000Z', buildRef: 'abc1234', summary: {} },
    criteria: {
      met: 1,
      total: 2,
      allMet: false,
      items: [
        { criterion: { kind: 'pass-rate', params: {} }, label: '≥ 95% of P0 passed', met: true, actual: '100%', detail: '' },
        { criterion: { kind: 'review-queue-empty', params: {} }, label: 'Review queue empty', met: false, actual: '3 pending', detail: '3 items waiting' },
      ],
    },
  },
  { planId: 'p2', plan: 'Nightly', release: null, run: null, criteria: null },
];
const COVERAGE = [
  { key: 'SHOP-REQ-1', title: 'Guest checkout', status: 'failing', cases: [{ key: 'SHOP-TC-42', title: 'Guest checkout', lastVerdict: 'failed', lastRunAt: null }] },
  { key: 'SHOP-REQ-2', title: 'Orphan', status: 'uncovered', cases: [] },
];

const handlers = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  'analytics.passRateSeries': () => SERIES,
  'analytics.resultsBySuite': () => BY_SUITE,
  'analytics.flakyTop': () => [{ key: 'SHOP-TC-45', title: 'Cart keeps items', flakiness: 0.4, quarantined: false }],
  'analytics.slowestTop': () => [{ key: 'SHOP-TC-51', title: 'Order email arrives', avgDurationMs: 65_000, runs: 4, mode: 'explore' }],
  'analytics.modeMix': () => ({ replay: 60, heal: 10, explore: 30 }),
  'analytics.aiQuality': () => AI,
  'analytics.releaseReadiness': () => READY,
  'analytics.coverage': () => COVERAGE,
  'environments.list': () => [{ id: 'e1', name: 'dev' }, { id: 'e2', name: 'staging' }],
  'suites.tree': () => ({ tree: [{ id: 's1', name: 'Auth', children: [] }], totalCases: 1, unsortedCases: 0 }),
  ...over,
});

function renderPage(view: AnalyticsView = 'quality', search: AnalyticsSearch = {}, over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc(handlers(over));
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AnalyticsPage projectKey="SHOP" view={view} search={search} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, router };
}

describe('model helpers', () => {
  it('formats values', () => {
    expect(formatDuration(820)).toBe('820 ms');
    expect(formatDuration(2400)).toBe('2.4 s');
    expect(formatDuration(65_000)).toBe('1 m 05 s');
    expect(formatDuration(null)).toBe('—');
    expect(formatPct(12.5)).toBe('12.5%');
    expect(formatPct(30)).toBe('30%');
    expect(formatPct(null)).toBe('—');
    expect(dayLabel('2026-10-09')).toBe('Oct 9');
  });

  it('parses the URL', () => {
    expect(parseSearch({ range: '7', env: 'dev', suite: '' })).toEqual({ range: 7, env: 'dev' });
    expect(parseSearch({ range: '5' })).toEqual({});
    expect(parseView('coverage')).toBe('coverage');
    expect(parseView('nope')).toBe('quality');
  });

  it('writes CSV with quoting and formula guards', () => {
    expect(toCsv([['a', 'b,c', 'say "x"'], [1, null, '=SUM(A1)']])).toBe('a,"b,c","say ""x"""\r\n1,,\'=SUM(A1)');
  });
});

describe('charts', () => {
  it('describes the pass-rate lines and legend', () => {
    render(<PassRateChart series={SERIES} selectedEnv={undefined} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Daily pass rate by environment, 3 days. Latest: dev 85.5%, staging 95%.');
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toMatchInlineSnapshot(`
      [
        "dev",
        "staging",
      ]
    `);
  });

  it('shows the empty state without results', () => {
    render(<PassRateChart series={{ environments: [], points: [], total: 0 }} selectedEnv={undefined} />);
    expect(screen.getByText('No runs in this period')).toBeInTheDocument();
  });

  it('draws stacked suite bars from tokens with a text legend', () => {
    const { container } = render(<SuiteBars rows={BY_SUITE} />);
    expect(screen.getByRole('img', { name: 'Search: 8 passed, 1 review, 1 failed' })).toBeInTheDocument();
    const segments = [...container.querySelectorAll('[data-segment]')].map((el) => `${el.getAttribute('data-segment')}:${(el as HTMLElement).style.flexGrow}:${el.className}`);
    expect(segments.slice(0, 3)).toMatchInlineSnapshot(`
      [
        "passed:9:bg-chart-1",
        "review:0:bg-warning-bar",
        "failed:1:bg-danger",
      ]
    `);
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Failed (incl. flaky)')).toBeInTheDocument();
  });
});

describe('AnalyticsPage', () => {
  it('renders the quality view with every card', async () => {
    renderPage();
    expect(await screen.findByRole('img', { name: /Daily pass rate by environment/ })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Auth: 9 passed, 0 review, 1 failed' })).toBeInTheDocument();
    expect(await screen.findByText('Cart keeps items', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(await screen.findByText(/Order email arrives/)).toBeInTheDocument();
    expect(screen.getByText('1 m 05 s · explore')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quarantine list' })).toBeInTheDocument();
    expect(await screen.findByText('AI model quality · System 1 (clef-flash)')).toBeInTheDocument();
    expect(screen.getByText('12.5%')).toBeInTheDocument();
    expect(screen.getByText('0.123')).toBeInTheDocument();
    expect(screen.getByText('180 ms / 1.2 s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recalibrate from 42 reviewed decisions' })).toBeDisabled();
    expect(screen.getByText('Thresholds have not been tuned yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Compare models' })).toBeInTheDocument();
  });

  it('sends the filters with every query and changes them from the header menus', async () => {
    const user = userEvent.setup();
    const { fake, router } = renderPage('quality', { range: 7, env: 'staging', suite: 's1' });
    await screen.findByText('Cart keeps items', { exact: false });
    const series = fake.calls.find((c) => c.path === 'analytics.passRateSeries');
    expect(series?.input).toEqual({ projectKey: 'SHOP', range: 7, environment: 'staging', suite: 's1' });

    await user.click(screen.getByRole('button', { name: 'Date range: Last 7 days' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Last 90 days' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ range: 90, env: 'staging', suite: 's1' }));
  });

  it('shows empty states when nothing ran', async () => {
    renderPage('quality', {}, {
      'analytics.passRateSeries': () => ({ environments: [], points: [], total: 0 }),
      'analytics.resultsBySuite': () => [],
      'analytics.flakyTop': () => [],
      'analytics.slowestTop': () => [],
      'analytics.modeMix': () => ({ replay: 0, heal: 0, explore: 0 }),
      'analytics.aiQuality': () => ({ ...AI, decisions: 0, escalationRate: null, overrideRate: null, ece: null, latencyP50: null, latencyP95: null, healSuccessRate: null, needsReviewRate: null }),
    });
    expect(await screen.findAllByText('No runs in this period')).toHaveLength(3);
    expect(await screen.findByText('No flaky cases detected.')).toBeInTheDocument();
    expect(await screen.findByText('No model decisions in this period.')).toBeInTheDocument();
  });

  it('reports a failing query with a retry', async () => {
    renderPage('quality', {}, {
      'analytics.resultsBySuite': () => {
        throw new Error('boom');
      },
    });
    expect(await screen.findByText(/Could not load this section: boom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders release readiness with criteria status', async () => {
    renderPage('readiness');
    const card = await screen.findByRole('region', { name: 'Plan Release 1.4' });
    expect(within(card).getByText('Not ready')).toBeInTheDocument();
    expect(within(card).getByText(/1 of 2 criteria met/)).toBeInTheDocument();
    expect(within(card).getByText('✓ Met', { exact: false })).toBeInTheDocument();
    expect(within(card).getByText('✗ Not met', { exact: false })).toBeInTheDocument();
    const nightly = screen.getByRole('region', { name: 'Plan Nightly' });
    expect(within(nightly).getByText('No run yet')).toBeInTheDocument();
  });

  it('renders the requirement coverage matrix', async () => {
    renderPage('coverage');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('Failing')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('SHOP-TC-42')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Uncovered')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('No covering case')).toBeInTheDocument();
  });

  it('shows the AI view and exports the current view as CSV', async () => {
    const user = userEvent.setup();
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      saved.push(b as Blob);
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderPage('ai');
    await screen.findByText('Overridden by humans');
    await user.click(screen.getByRole('button', { name: 'Export current view as CSV' }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await saved[0]?.text();
    expect(text).toContain('Escalated to S2 / human %,12.5');
    expect(text).toContain('Decision latency p95 ms,1200');
    click.mockRestore();
  });
});
