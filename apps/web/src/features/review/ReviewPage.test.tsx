import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { approveAllLabel, defaultTab, itemMeta, parseStatus, parseTab, s2Line, tabLabel, thresholdText } from './model';
import { ReviewPage, type ReviewSearch } from './ReviewPage';

import { createFakeTrpc, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

const healItem = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  tab: 'heals',
  status: 'pending',
  createdAt: null,
  resolvedAt: null,
  caseKey: 'SHOP-TC-42',
  title,
  stepNumber: 2,
  confidence: 0.62,
  sharedStepName: 'guest-checkout',
  impactCount: 6,
  environment: '',
  browser: null,
  ...over,
});
const verdictItem = (id: string) => ({
  id,
  tab: 'verdicts',
  status: 'pending',
  createdAt: null,
  resolvedAt: null,
  caseKey: 'SHOP-TC-51',
  title: 'Order confirmation email arrives',
  stepNumber: 3,
  confidence: 0.55,
  sharedStepName: null,
  impactCount: null,
  environment: 'staging',
  browser: 'webkit',
});

const HEAL_DETAIL = {
  kind: 'heal',
  item: { id: 'h1', projectId: 'p1', kind: 'heal', refId: 'hp1', status: 'pending' },
  projectKey: 'SHOP',
  proposalId: 'hp1',
  proposalStatus: 'pending',
  caseKey: 'SHOP-TC-42',
  caseTitle: 'Guest checkout',
  stepNumber: 2,
  stepAction: 'Go to checkout as guest',
  environment: 'staging',
  runId: 'run-abc123',
  runFound: true,
  browser: 'chromium',
  sharedStepName: 'guest-checkout',
  beforeLabel: 'Guest checkout',
  afterLabel: 'Checkout as guest',
  before: ["getByRole('button', {name: 'Guest checkout'})"],
  after: ["getByRole('button', {name: 'Checkout as guest'})"],
  confidence: 0.62,
  s2Agreed: true,
  approvedLive: 'maya',
  impactCount: 6,
  impactCaseKeys: [],
};
const VERDICT_DETAIL = {
  kind: 'verdict',
  item: { id: 'v1', projectId: 'p1', kind: 'verdict', refId: 'cr1', status: 'pending' },
  projectKey: 'SHOP',
  resultId: 'cr1',
  runId: 'run-abc123',
  caseKey: 'SHOP-TC-51',
  caseTitle: 'Order confirmation email arrives',
  environment: 'staging',
  browser: 'webkit',
  verdict: 'needs-review',
  stepNumber: 3,
  expected: 'A confirmation banner is shown',
  pTrue: 0.55,
  thresholds: { pass: 0.8, fail: 0.2 },
  model: 'clef-flash',
  assertions: [{ stepNumber: 3, assertion: 'ai', verdict: 'needs-review', probability: 0.55, message: null }],
  screenshotId: 'shot1',
};

function renderPage(search: ReviewSearch = {}, over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc({
    'reviews.counts': () => ({ verdicts: 1, heals: 2, drafts: 0, visual: 0 }),
    'reviews.list': (i) => {
      const { tab } = i as { tab: string };
      if (tab === 'heals') return { page: 1, pageSize: 20, total: 2, items: [healItem('h1', '“Guest checkout” → “Checkout as guest”'), healItem('h2', 'Promo field moved', { sharedStepName: null, impactCount: 1 })] };
      if (tab === 'verdicts') return { page: 1, pageSize: 20, total: 1, items: [verdictItem('v1')] };
      return { page: 1, pageSize: 20, total: 0, items: [] };
    },
    'reviews.get': (id) => (id === 'v1' ? VERDICT_DETAIL : HEAL_DETAIL),
    ...over,
  });
  const onSearch = vi.fn();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ReviewPage projectKey="SHOP" search={search} onSearch={onSearch} /> }),
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
  it('formats tabs, labels and lines', () => {
    const counts = { verdicts: 0, heals: 3, drafts: 0, visual: 0 };
    expect(defaultTab(counts)).toBe('heals');
    expect(defaultTab(undefined)).toBe('verdicts');
    expect(tabLabel('heals', counts)).toBe('Heal proposals · 3');
    expect(parseTab('heals')).toBe('heals');
    expect(parseTab('x')).toBeUndefined();
    expect(parseStatus('resolved')).toBe('resolved');
    expect(approveAllLabel(6)).toBe('Approve for all 6 cases');
    expect(approveAllLabel(1)).toBe('Approve for all 1 case');
    expect(s2Line(true, 'maya')).toBe('S2 agreed · approved live by maya');
    expect(s2Line(null, null)).toBe('S2 not consulted');
    expect(thresholdText(null)).toContain('No thresholds');
    expect(itemMeta({ tab: 'heals', caseKey: 'K', stepNumber: 2, confidence: 0.62, sharedStepName: 'x', impactCount: 6, environment: '', browser: null })).toBe(
      'Shared step “x” · used by 6 cases · conf 0.62',
    );
  });
});

describe('ReviewPage', () => {
  it('shows tab counts, the heal list and the first heal detail by default', async () => {
    renderPage({}, { 'reviews.counts': () => ({ verdicts: 0, heals: 2, drafts: 0, visual: 0 }) });
    const tabs = await screen.findByRole('navigation', { name: 'Queue type' });
    await waitFor(() => expect(within(tabs).getByRole('link', { name: 'Heal proposals · 2' })).toHaveAttribute('aria-current', 'page'));
    expect(within(tabs).getByRole('link', { name: 'Uncertain verdicts · 0' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: 'Generated drafts · 0' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: 'Visual changes · 0' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Review items' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Shared step “guest-checkout” · used by 6 cases · conf 0.62')).toBeInTheDocument();
    const detail = await screen.findByRole('region', { name: 'Proposal detail' });
    expect(within(detail).getByText('Before · learned script')).toBeInTheDocument();
    expect(within(detail).getByText('After · proposed by S1')).toBeInTheDocument();
    expect(detail.querySelector('[data-diff="removed"]')).toHaveTextContent("getByRole('button', {name: 'Guest checkout'})");
    expect(detail.querySelector('[data-diff="added"]')).toHaveTextContent("getByRole('button', {name: 'Checkout as guest'})");
    expect(within(detail).getByText('S2 agreed · approved live by maya')).toBeInTheDocument();
    expect(within(detail).getByText('via shared step · all environments')).toBeInTheDocument();
    expect(within(detail).getByText('Is this a bug?')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Approve for all 6 cases' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Approve for this case only' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Reject & create defect' })).toBeInTheDocument();
    expect(within(detail).getByLabelText('Note (optional)')).toBeInTheDocument();
  });

  it('approves for all cases with the note and advances to the next item', async () => {
    const user = userEvent.setup();
    const { fake, onSearch } = renderPage({ tab: 'heals' }, { 'reviews.decide': () => ({ item: { id: 'h1', status: 'approved' }, nextId: 'h2' }) });
    await screen.findByRole('button', { name: 'Approve for all 6 cases' });
    await user.type(screen.getByLabelText('Note (optional)'), 'Intentional');
    await user.click(screen.getByRole('button', { name: 'Approve for all 6 cases' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'reviews.decide')).toBeDefined());
    expect(fake.calls.find((c) => c.path === 'reviews.decide')?.input).toEqual({ id: 'h1', decision: 'approve', note: 'Intentional' });
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith({ tab: 'heals', item: 'h2' }, { replace: true }));
    await waitFor(() => expect(fake.calls.filter((c) => c.path === 'reviews.counts').length).toBeGreaterThan(1));
  });

  it('sends case-only and reject decisions', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ tab: 'heals' }, { 'reviews.decide': () => ({ item: {}, nextId: null }) });
    await user.click(await screen.findByRole('button', { name: 'Approve for this case only' }));
    await waitFor(() => expect(fake.calls.filter((c) => c.path === 'reviews.decide')).toHaveLength(1));
    expect(fake.calls.find((c) => c.path === 'reviews.decide')?.input).toMatchObject({ decision: 'approve-case-only' });
    await user.click(screen.getByRole('button', { name: 'Reject & create defect' }));
    await waitFor(() => expect(fake.calls.filter((c) => c.path === 'reviews.decide')).toHaveLength(2));
    expect(fake.calls.filter((c) => c.path === 'reviews.decide')[1]?.input).toMatchObject({ decision: 'reject' });
  });

  it('shows the uncertain verdict with its probability and marks it passed or failed', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ tab: 'verdicts' }, { 'reviews.decide': () => ({ item: {}, nextId: null }) });
    const detail = await screen.findByRole('region', { name: 'Verdict detail' });
    expect(within(detail).getByText('A confirmation banner is shown')).toBeInTheDocument();
    expect(within(detail).getByText('P(expected result is true)')).toBeInTheDocument();
    expect(within(detail).getAllByText('0.55').length).toBeGreaterThan(0);
    expect(within(detail).getByText(/Fail at or below 0.20, pass at or above 0.80/)).toBeInTheDocument();
    expect(within(detail).getByRole('img', { name: /Screenshot after step 3/ })).toHaveAttribute('src', '/api/artifacts/shot1');
    await user.click(within(detail).getByRole('button', { name: 'Mark failed' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'reviews.decide')).toBeDefined());
    expect(fake.calls.find((c) => c.path === 'reviews.decide')?.input).toEqual({ id: 'v1', decision: 'reject', note: '', verdict: 'failed' });
  });

  it('shows placeholders for tabs without items and an error state', async () => {
    renderPage({ tab: 'drafts' });
    expect(await screen.findByText(/Generated drafts arrive with AI test generation/)).toBeInTheDocument();
  });

  it('shows a decided item without action buttons', async () => {
    renderPage(
      { tab: 'heals', status: 'resolved' },
      { 'reviews.get': () => ({ ...HEAL_DETAIL, item: { ...HEAL_DETAIL.item, status: 'rejected', note: 'Looks like a bug' } }) },
    );
    expect(await screen.findByText(/Rejected/, { selector: 'div' })).toHaveTextContent('Looks like a bug');
    expect(screen.queryByRole('button', { name: 'Reject & create defect' })).not.toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    renderPage({}, { 'reviews.list': () => Promise.reject(new Error('boom')) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the review queue');
  });
});
