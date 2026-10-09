import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DefectsPage } from './DefectsPage';
import { failingLabel, parseSearch, severityLabel, severityTone, shortSha, statusText } from './model';
import type { DefectsSearch } from './model';

import { createFakeTrpc, FakeTrpcError, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  key: 'DEF-1',
  title: 'Invalid ZIP accepted at checkout',
  severity: 'S2',
  status: 'open',
  source: 'SHOP-TC-44',
  sourceKind: 'result',
  failingBrowsers: ['webkit', 'firefox'],
  failingCount: 2,
  tracker: null,
  retest: true,
  retestRunId: null,
  createdAt: null,
  ...over,
});

const DRAFT = {
  projectKey: 'SHOP',
  resultId: 'cr1',
  stepNumber: 3,
  title: 'Cart empties after reload on iOS Safari',
  severity: 'S2',
  details: {
    stepsToReproduce: ['Add “Classic Tee” to the cart', 'Reload the page', 'Open the cart'],
    expected: 'Item still in cart',
    actual: 'Cart is empty',
    environment: 'staging',
    browser: 'webkit',
    buildRef: 'abcdef1234567890',
    evidence: [{ artifactId: 'shot1', kind: 'screenshot' }],
    sourceKind: 'result',
    sourceLabel: 'SHOP-TC-45',
    stepIndex: 2,
    retest: true,
  },
};

const DETAIL = {
  defect: { id: 'd1', projectId: 'p1', title: 'Invalid ZIP accepted at checkout', severity: 'S2', status: 'open', linkedResultIds: ['cr1'], updatedAt: 't1', details: { ...DRAFT.details, retest: true } },
  key: 'DEF-1',
  projectKey: 'SHOP',
  linked: [{ id: 'cr1', runId: 'run1', caseKey: 'SHOP-TC-44', caseTitle: 'ZIP validation', verdict: 'failed', browser: 'webkit' }],
};

function renderPage(search: DefectsSearch = {}, over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc({
    'defects.list': () => ({ total: 2, items: [row(), row({ id: 'd2', key: 'DEF-2', title: 'Missing label', severity: 'S3', source: null, failingBrowsers: [], status: 'fixed', retestRunId: 'run9', tracker: { provider: 'jira', id: 'SHOP-12', url: 'https://jira.test/SHOP-12' } })] }),
    'defects.createFromResult': () => DRAFT,
    'defects.get': () => DETAIL,
    ...over,
  });
  const onSearch = vi.fn();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <DefectsPage projectKey="SHOP" search={search} onSearch={onSearch} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, onSearch };
}

describe('model helpers', () => {
  it('formats labels', () => {
    expect(severityLabel('S2')).toBe('S2 · Major');
    expect(severityTone('S1')).toBe('danger');
    expect(severityTone('S3')).toBe('warning');
    expect(failingLabel(['webkit', 'firefox'])).toBe('WebKit, Firefox');
    expect(failingLabel([])).toBe('–');
    expect(statusText('fixed', 'r')).toBe('Fixed · re-test queued');
    expect(statusText('in-progress', null)).toBe('In progress');
    expect(shortSha('abcdef1234567890')).toBe('abcdef1');
    expect(parseSearch({ q: 'status:open', step: '2', new: 'true', defect: '' })).toEqual({ q: 'status:open', step: 2, new: true });
  });
});

describe('DefectsPage', () => {
  it('lists defects with severity, failing results, tracker and status', async () => {
    renderPage({ q: 'status:open' });
    const table = await screen.findByRole('table');
    await screen.findByText('Invalid ZIP accepted at checkout');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('DEF-1')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('S2 · Major')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('WebKit, Firefox')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Not pushed')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('from SHOP-TC-44')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByRole('link', { name: 'SHOP-12 ↗' })).toHaveAttribute('href', 'https://jira.test/SHOP-12');
    expect(within(rows[2] as HTMLElement).getByText('Fixed · re-test queued')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter defects')).toHaveValue('status:open');
    expect(screen.getByText(/Local defects/)).toBeInTheDocument();
  });

  it('sends the filter to the server and shows a filter error', async () => {
    const user = userEvent.setup();
    const { fake, onSearch } = renderPage(
      {},
      { 'defects.list': (i) => { if ((i as { query: string }).query === 'status:nope') throw new FakeTrpcError('Unknown status "nope"', 'BAD_REQUEST'); return { total: 0, items: [] }; } },
    );
    await screen.findByText(/No defects yet/);
    await user.type(screen.getByLabelText('Filter defects'), 'status:open');
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith({ q: 'status:open' }, { replace: true }));
    expect(fake.calls.some((c) => c.path === 'defects.list')).toBe(true);
  });

  it('shows an empty-filter state and the filter error', async () => {
    renderPage({ q: 'status:nope' }, { 'defects.list': () => { throw new FakeTrpcError('Unknown status "nope"', 'BAD_REQUEST'); } });
    expect(await screen.findByText(/Filter problem: Unknown status "nope"/)).toBeInTheDocument();
  });

  it('prefills the new defect form from a result and creates it', async () => {
    const user = userEvent.setup();
    const { fake, onSearch } = renderPage({ fromResult: 'cr1', step: 2 }, { 'defects.create': () => ({ id: 'dNew' }) });
    await screen.findByDisplayValue('Cart empties after reload on iOS Safari');
    const aside = screen.getByRole('complementary', { name: 'Create defect' });
    expect(within(aside).getByText(/Pre-filled from result/)).toHaveTextContent('SHOP-TC-45 · step 3');
    expect(within(aside).getByLabelText('Severity')).toHaveValue('S2');
    expect(within(aside).getByText('Steps to reproduce · auto')).toBeInTheDocument();
    expect(within(aside).getByText('3. Open the cart')).toBeInTheDocument();
    expect(within(aside).getByText('Item still in cart')).toBeInTheDocument();
    expect(within(aside).getByText('Cart is empty')).toBeInTheDocument();
    expect(within(aside).getByText('abcdef1')).toBeInTheDocument();
    expect(within(aside).getByRole('checkbox', { name: 'Push to tracker' })).toBeDisabled();
    expect(within(aside).getByRole('checkbox', { name: 'Re-test automatically when closed' })).toBeChecked();
    expect(fake.calls.find((c) => c.path === 'defects.createFromResult')?.input).toEqual({ resultId: 'cr1', stepIndex: 2 });
    await user.selectOptions(within(aside).getByLabelText('Severity'), 'S1');
    await user.click(within(aside).getByRole('button', { name: 'Create defect' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'defects.create')).toBeDefined());
    expect(fake.calls.find((c) => c.path === 'defects.create')?.input).toMatchObject({
      projectKey: 'SHOP',
      title: 'Cart empties after reload on iOS Safari',
      severity: 'S1',
      resultIds: ['cr1'],
      details: { retest: true, expected: 'Item still in cart', browser: 'webkit' },
    });
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith({ defect: 'dNew' }));
  });

  it('pushes a new defect to the mapped tracker and shows the sync eyebrow', async () => {
    const user = userEvent.setup();
    const mapping = { provider: 'jira', jiraProject: 'SHOP', connected: true, label: 'Jira project SHOP' };
    const { fake } = renderPage(
      { fromResult: 'cr1', step: 2 },
      { 'defects.create': () => ({ id: 'dNew' }), 'trackers.mapping': () => mapping, 'trackers.push': () => ({ id: 'dNew' }) },
    );
    expect(await screen.findByText(/synced with Jira project SHOP/)).toBeInTheDocument();
    const aside = await screen.findByRole('complementary', { name: 'Create defect' });
    const box = await within(aside).findByRole('checkbox', { name: 'Push to Jira · Jira project SHOP' });
    expect(box).toBeEnabled();
    expect(box).toBeChecked();
    await user.click(within(aside).getByRole('button', { name: 'Create defect' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'trackers.push')?.input).toBe('dNew'));
  });

  it('offers a Push button for an unpushed defect', async () => {
    const mapping = { provider: 'jira', jiraProject: 'SHOP', connected: true, label: 'Jira project SHOP' };
    renderPage({ defect: 'd1' }, { 'trackers.mapping': () => mapping });
    expect(await screen.findByRole('button', { name: 'Push to Jira' })).toBeEnabled();
  });

  it('links the pushed issue in the detail panel', async () => {
    const pushed = { ...DETAIL, defect: { ...DETAIL.defect, external: { provider: 'jira', id: 'SHOP-12', url: 'https://jira.test/SHOP-12' } } };
    renderPage({ defect: 'd1' }, { 'defects.get': () => pushed });
    await screen.findByRole('button', { name: 'Close defect' });
    const aside = screen.getByRole('complementary', { name: 'Defect detail' });
    expect(within(aside).getByRole('link', { name: 'SHOP-12 ↗' })).toHaveAttribute('href', 'https://jira.test/SHOP-12');
  });

  it('creates a manual defect without a result', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ new: true }, { 'defects.create': () => ({ id: 'dNew' }) });
    const aside = await screen.findByRole('complementary', { name: 'Create defect' });
    expect(within(aside).getByRole('button', { name: 'Create defect' })).toBeDisabled();
    await user.type(within(aside).getByLabelText('Title'), 'Footer typo');
    await user.type(within(aside).getByLabelText('Steps to reproduce'), 'Open home{Enter}Scroll down');
    await user.click(within(aside).getByRole('button', { name: 'Create defect' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'defects.create')).toBeDefined());
    expect(fake.calls.find((c) => c.path === 'defects.create')?.input).toMatchObject({
      title: 'Footer typo',
      severity: 'S3',
      resultIds: [],
      details: { stepsToReproduce: ['Open home', 'Scroll down'], sourceKind: 'manual', retest: true },
    });
  });

  it('shows the selected defect and closes it', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ defect: 'd1' }, { 'defects.update': () => ({ ...DETAIL.defect, status: 'closed', details: { ...DETAIL.defect.details, retestRunId: 'run-retest-1' } }) });
    await screen.findByDisplayValue('Invalid ZIP accepted at checkout');
    const aside = screen.getByRole('complementary', { name: 'Defect detail' });
    expect(within(aside).getByRole('link', { name: 'SHOP-TC-44' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
    await user.click(within(aside).getByRole('button', { name: 'Close defect' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'defects.update')).toBeDefined());
    expect(fake.calls.find((c) => c.path === 'defects.update')?.input).toMatchObject({ id: 'd1', status: 'closed', details: { retest: true } });
    expect(await within(aside).findByText(/Re-test queued as run/)).toBeInTheDocument();
  });
});
