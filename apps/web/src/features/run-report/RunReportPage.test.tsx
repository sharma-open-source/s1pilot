import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { attemptTotals, bucketOf, defaultFilter, detailTitle, matchesFilter, resultMeta, runDuration } from './model';
import { RunReportPage, type RunReportSearch } from './RunReportPage';

import { createFakeTrpc, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

const SUMMARY = { passed: 1, failed: 2, blocked: 0, skipped: 0, flaky: 0, needsReview: 1 };
const row = (id: string, key: string, verdict: string, over: Record<string, unknown> = {}) => ({
  id,
  caseId: `c-${id}`,
  key,
  title: `Title of ${key}`,
  verdict,
  environment: 'staging',
  browser: 'webkit',
  mode: 'explore',
  attempt: 1,
  durationMs: 10,
  failedStep: verdict === 'failed' ? 3 : null,
  checks: [] as Array<{ kind: string; severity: string; count: number }>,
  ...over,
});
const REPORT = {
  run: { id: 'run-abc123', projectId: 'p1', trigger: 'manual', status: 'failed', buildRef: 'a1b2c3d', summary: SUMMARY },
  projectKey: 'SHOP',
  environments: ['staging'],
  exitCriteria: null,
  results: [row('r1', 'SHOP-TC-1', 'passed'), row('r2', 'SHOP-TC-44', 'failed'), row('r3', 'SHOP-TC-45', 'failed', { browser: 'firefox' }), row('r4', 'SHOP-TC-51', 'needs-review')],
};
const detail = (id: string) => {
  const r = REPORT.results.find((x) => x.id === id) as ReturnType<typeof row>;
  return {
    result: { id, runId: 'run-abc123', caseId: r.caseId, caseVersion: 1, browser: r.browser, attempt: 1, verdict: r.verdict, durationMs: 10, mode: 'explore', escalations: 0 },
    projectKey: 'SHOP',
    case: { id: r.caseId, key: r.key, title: r.title },
    environment: 'staging',
    failedStep: r.failedStep,
    steps: [
      { id: 's0', caseResultId: id, stepIndex: 0, status: 'passed', mode: 'replay', decisions: [], assertions: [], evidence: [], latencyMs: 5, action: 'Add item' },
      {
        id: 's1',
        caseResultId: id,
        stepIndex: 1,
        status: 'failed',
        mode: 'explore',
        actionTaken: 'fill e12 (textbox "ZIP")',
        decisions: [{ questionId: 'pick', options: ['e12', 'e15'], probabilities: { e12: 0.97, e15: 0.03 }, chosen: 'e12', confidence: 0.97, model: 'clef-flash', latencyMs: 80 }],
        assertions: [{ assertion: 'ai', verdict: 'fail', probability: 0.07 }],
        evidence: [],
        latencyMs: 90,
        action: 'Enter ZIP',
        expected: 'An error appears next to the ZIP field',
        screenshotId: 'art-shot',
      },
    ],
    notRun: [{ index: 2, action: 'Pay' }],
    video: { artifactId: 'art-video' },
    trace: { artifactId: 'art-trace', size: 10 },
    console: [{ ts: 't', type: 'error', text: 'Boom' }],
    network: [{ url: 'http://x.test/api', method: 'GET', status: 500, durationMs: 12, resourceType: 'fetch' }],
    checks: [] as Array<Record<string, unknown>>,
    overrides: [],
  };
};

function handlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'runs.report': () => REPORT,
    'results.get': (id) => detail(id as string),
    ...over,
  };
}

function renderPage(search: RunReportSearch = {}, over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc(handlers(over));
  const onSearch = vi.fn();
  const navigate = vi.fn();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <RunReportPage projectKey="SHOP" runId="run-abc123" search={search} onSearch={onSearch} navigate={navigate} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, onSearch, navigate };
}

describe('model helpers', () => {
  it('buckets verdicts into filters', () => {
    expect(bucketOf('blocked')).toBe('failed');
    expect(bucketOf('needs-review')).toBe('review');
    expect(matchesFilter('passed', 'failed')).toBe(false);
    expect(matchesFilter('passed', 'all')).toBe(true);
    expect(defaultFilter(['passed', 'needs-review'])).toBe('review');
    expect(defaultFilter(['passed'])).toBe('all');
    expect(resultMeta({ caseId: 'c1', attempt: 1, environment: 'staging', browser: 'webkit', failedStep: 3 })).toBe('staging · WebKit · step 3');
    expect(detailTitle('SHOP-TC-44', 'webkit', 'failed', 3)).toBe('SHOP-TC-44 · WebKit · failed at step 3');
  });
});

describe('attempts and durations', () => {
  it('labels retried cases with their attempt number and shows durations', () => {
    const base = { caseId: 'c1', environment: 'dev', browser: 'chromium', failedStep: 2, durationMs: 12_400 };
    const rows = [1, 2, 3].map((attempt) => ({ ...base, attempt }));
    const totals = attemptTotals([...rows, { ...base, caseId: 'c2', attempt: 1 }]);
    expect(rows.map((r) => resultMeta(r, totals))).toEqual([
      'dev · Chromium · attempt 1 of 3 · step 2 · 12.4 s',
      'dev · Chromium · attempt 2 of 3 · step 2 · 12.4 s',
      'dev · Chromium · attempt 3 of 3 · step 2 · 12.4 s',
    ]);
    expect(resultMeta({ ...base, caseId: 'c2', attempt: 1, failedStep: null, durationMs: 850 }, totals)).toBe('dev · Chromium · 850 ms');
    expect(runDuration('2026-10-13T10:00:00Z', '2026-10-13T10:03:05Z')).toBe('3m 05s');
    expect(runDuration('2026-10-13T10:00:00Z', '2026-10-13T10:00:42Z')).toBe('42 s');
    expect(runDuration('2026-10-13T10:00:00Z', undefined)).toBeNull();
  });
});

describe('RunReportPage', () => {
  it('shows the summary tiles, the failed list by default and the first result detail', async () => {
    renderPage();
    const summary = await screen.findByRole('region', { name: 'Summary' });
    await waitFor(() => expect(within(summary).getByText('Needs review').nextSibling).toHaveTextContent('1'));
    expect(within(summary).getByText('Exit criteria').nextSibling).toHaveTextContent('–');
    const list = screen.getByRole('list', { name: 'Result list' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('staging · WebKit · step 3 · 10 ms')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'SHOP-TC-44 · WebKit · failed at step 3' })).toBeInTheDocument();
    expect(screen.getByText('An error appears next to the ZIP field')).toBeInTheDocument();
    expect(screen.getByText('fill e12 (textbox "ZIP")', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('AI check')).toBeInTheDocument();
    expect(screen.getByText('0.07')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit case' })).toHaveAttribute('href', '/p/SHOP/cases/SHOP-TC-44');
    expect(screen.getByRole('link', { name: 'Create defect' }).getAttribute('href')).toMatch(/^\/p\/SHOP\/defects\?fromResult=\w+&step=\d+/);
    expect(screen.getByRole('button', { name: 'Open screenshot of step 2' })).toBeInTheDocument();
  });

  it('opens the result named by ?result= (deep link), even outside the default filter', async () => {
    renderPage({ result: 'r4' });
    expect(await screen.findByRole('heading', { name: 'SHOP-TC-51 · WebKit · needs review' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Result list' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByRole('link', { name: /SHOP-TC-51/ })).toHaveAttribute('aria-current', 'true');
  });

  it('switches the filter through the search params', async () => {
    const user = userEvent.setup();
    const { onSearch } = renderPage();
    await screen.findByRole('list', { name: 'Result list' });
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onSearch).toHaveBeenCalledWith({ filter: 'all' });
  });

  it('shows evidence tabs with the trace warning, console and network', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: /SHOP-TC-44/ });
    expect(screen.getAllByText(/clef-flash/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: 'Playwright trace' }));
    expect(screen.getByText(/not masked for secrets/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download trace.zip' })).toHaveAttribute('href', '/api/artifacts/art-trace');
    await user.click(screen.getByRole('tab', { name: 'Console · 1' }));
    expect(screen.getByText(/Boom/)).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Network · 1' }));
    expect(screen.getByText('http://x.test/api')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Video' }));
    expect(document.querySelector('video')).toHaveAttribute('src', '/api/artifacts/art-video');
  });

  it('shows a warning pill on results with warning checks and the Accessibility tab with violations', async () => {
    const user = userEvent.setup();
    const a11yCheck = {
      kind: 'a11y',
      severity: 'fail',
      items: [
        { summary: 'Form elements must have labels', severity: 'fail', ruleId: 'label', impact: 'critical', target: 'input[name="email"]', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/label', stepIndex: 0 },
        { summary: 'Heading levels should only increase by one', severity: 'warn', ruleId: 'heading-order', impact: 'moderate', target: 'h4', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/heading-order' },
      ],
    };
    const consoleCheck = { kind: 'console', severity: 'warn', items: [{ summary: 'Boom', severity: 'warn', type: 'error', stepIndex: 1 }] };
    const report = {
      ...REPORT,
      results: REPORT.results.map((r) => (r.id === 'r2' ? { ...r, checks: [{ kind: 'a11y', severity: 'fail', count: 2 }, { kind: 'console', severity: 'warn', count: 1 }] } : r)),
    };
    renderPage({}, {
      'runs.report': () => report,
      'results.get': (id) => (id === 'r2' ? { ...detail('r2'), checks: [a11yCheck, consoleCheck] } : detail(id as string)),
    });
    const list = await screen.findByRole('list', { name: 'Result list' });
    expect(within(list).getByText('1 warning')).toBeInTheDocument();
    await screen.findByRole('heading', { name: /SHOP-TC-44/ });
    await user.click(screen.getByRole('tab', { name: 'Accessibility · 2' }));
    const violations = screen.getByRole('list', { name: 'Accessibility violations' });
    expect(within(violations).getAllByRole('listitem')).toHaveLength(2);
    expect(within(violations).getByText('label')).toBeInTheDocument();
    expect(within(violations).getByText('critical')).toBeInTheDocument();
    expect(within(violations).getByText('input[name="email"]')).toBeInTheDocument();
    expect(within(violations).getAllByRole('link', { name: 'How to fix' })[0]).toHaveAttribute('href', 'https://dequeuniversity.com/rules/axe/4.10/label');
    await user.click(screen.getByRole('tab', { name: 'Console · 1' }));
    expect(screen.getByRole('list', { name: 'Flagged console errors' })).toHaveTextContent('Boom (step 2)');
  });

  it('explains an Accessibility tab without a scan', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: /SHOP-TC-44/ });
    await user.click(screen.getByRole('tab', { name: 'Accessibility' }));
    expect(screen.getByText(/accessibility scan was not enabled/)).toBeInTheDocument();
  });

  it('overrides a verdict and refreshes the report', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({}, { 'results.overrideVerdict': () => ({ ok: true }) });
    await screen.findByRole('heading', { name: /SHOP-TC-44/ });
    await user.click(screen.getByRole('button', { name: 'Override verdict' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('New verdict'), 'passed');
    await user.type(within(dialog).getByLabelText('Note'), 'Known data issue');
    const before = fake.calls.filter((c) => c.path === 'runs.report').length;
    await user.click(within(dialog).getByRole('button', { name: 'Save override' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'results.overrideVerdict')).toBeDefined());
    expect(fake.calls.find((c) => c.path === 'results.overrideVerdict')?.input).toEqual({ resultId: 'r2', verdict: 'passed', note: 'Known data issue' });
    await waitFor(() => expect(fake.calls.filter((c) => c.path === 'runs.report').length).toBeGreaterThan(before));
  });

  it('reruns failed cases and navigates to the new run', async () => {
    const user = userEvent.setup();
    const { navigate } = renderPage({}, { 'runs.rerunFailed': () => ({ id: 'run-new' }) });
    await screen.findByRole('list', { name: 'Result list' });
    await user.click(screen.getByRole('button', { name: 'Rerun failed' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/p/SHOP/runs/run-new/live'));
  });

  it('offers JUnit, HTML and JSON exports', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('list', { name: 'Result list' });
    await user.click(screen.getByRole('button', { name: /Export/ }));
    expect(await screen.findByRole('menuitem', { name: 'JUnit XML' })).toHaveAttribute('href', '/api/runs/run-abc123/export/junit');
    expect(screen.getByRole('menuitem', { name: 'HTML report' })).toHaveAttribute('href', '/api/runs/run-abc123/export/html');
    expect(screen.getByRole('menuitem', { name: 'JSON' })).toHaveAttribute('href', '/api/runs/run-abc123/export/json');
  });

  it('shows an error state when the report cannot load', async () => {
    renderPage({}, { 'runs.report': () => Promise.reject(new Error('boom')) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this run');
  });
});
