import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ManualRunPage } from './ManualRunPage';
import { currentStepIndex, formatTimer, queueStatusKey } from './model';

import { createFakeTrpc, FakeTrpcError, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

const step = (index: number, over: Record<string, unknown> = {}) => ({
  index,
  action: ['Add “Classic Tee” to the cart', 'Reload the page', 'Open the cart', 'Change quantity to 2'][index],
  expected: ['cart badge shows 1 item', 'page reloads without errors', 'Classic Tee is still in the cart', 'subtotal doubles'][index] ?? null,
  verdict: null,
  actual: '',
  attachments: [],
  preRun: null,
  confirmed: false,
  ...over,
});

const VIEW = {
  item: { id: 'm2', runId: 'run123456', status: 'in-progress', hybrid: true, notes: '' },
  projectKey: 'SHOP',
  caseKey: 'SHOP-TC-45',
  title: 'Cart keeps items after page reload',
  environment: 'staging',
  browser: 'webkit',
  device: null,
  buildRef: '2.4.0',
  steps: [
    step(0, { verdict: 'pass', confirmed: true, preRun: 'passed' }),
    step(1, { preRun: 'passed' }),
    step(2),
    step(3),
  ],
  queue: [
    { id: 'm1', runId: 'run123456', caseKey: 'SHOP-TC-44', title: 'ZIP', status: 'done', verdict: 'passed', hybrid: false },
    { id: 'm2', runId: 'run123456', caseKey: 'SHOP-TC-45', title: 'Cart', status: 'in-progress', verdict: null, hybrid: true },
    { id: 'm3', runId: 'run123456', caseKey: 'SHOP-TC-47', title: 'Other', status: 'todo', verdict: null, hybrid: false },
  ],
  position: 2,
  total: 3,
  previousId: 'm1',
  nextId: 'm3',
  elapsedMs: 83_000,
  timerRunning: true,
  serverNow: '2026-10-09T10:00:00.000Z',
  preRunBrowser: 'webkit',
  preRunStepCount: 2,
};

function renderPage(over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc({
    'manual.get': () => VIEW,
    'manual.start': () => VIEW,
    'manual.myQueue': () => [],
    ...over,
  });
  const onOpenItem = vi.fn();
  const onBackToQueue = vi.fn();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <ManualRunPage projectKey="SHOP" sessionId="m2" onOpenItem={onOpenItem} onBackToQueue={onBackToQueue} />,
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return { fake, onOpenItem, onBackToQueue };
}

describe('model helpers', () => {
  it('formats the timer and picks the current step', () => {
    expect(formatTimer(83_000)).toBe('1:23');
    expect(formatTimer(3_723_000)).toBe('1:02:03');
    expect(queueStatusKey('done', 'failed')).toBe('failed');
    expect(queueStatusKey('todo', null)).toBe('to-do');
    const steps = [
      { verdict: 'pass', preRun: 'passed', confirmed: true },
      { verdict: null, preRun: 'passed', confirmed: false },
      { verdict: null, preRun: null, confirmed: false },
    ];
    expect(currentStepIndex(steps, new Set(), undefined)).toBe(2);
    expect(currentStepIndex(steps, new Set([1]), undefined)).toBe(1);
    expect(currentStepIndex(steps, new Set(), 0)).toBe(0);
  });
});

describe('ManualRunPage', () => {
  it('renders the header, hybrid callout, step states and queue like the wireframe', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'SHOP-TC-45 · Cart keeps items after page reload' })).toBeInTheDocument();
    expect(screen.getByText(/case 2 of 3/)).toBeInTheDocument();
    expect(screen.getByText(/staging · WebKit/)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^1:2\d$|^1:3\d$/);
    expect(screen.getByRole('note')).toHaveTextContent('Hybrid mode: S1 pre-ran steps 1–2 on WebKit and passed them. Confirm or redo them on this device.');

    const done = screen.getByRole('article', { name: 'Step 1' });
    expect(within(done).getByText('Passed · confirmed')).toBeInTheDocument();
    const pre = screen.getByRole('article', { name: 'Step 2' });
    expect(within(pre).getByText('AI pre-run: passed · confirm?')).toBeInTheDocument();
    expect(within(pre).getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(within(pre).getByRole('button', { name: 'Redo' })).toBeInTheDocument();
    const cur = screen.getByRole('article', { name: 'Step 3' });
    expect(within(cur).getByRole('group', { name: 'Step 3 result' })).toBeInTheDocument();
    expect(within(cur).getByLabelText('Actual result')).toBeInTheDocument();
    expect(within(cur).getByRole('button', { name: '+ Attach screenshot or video' })).toBeInTheDocument();
    expect(within(cur).getByRole('link', { name: 'Create defect from this step' })).toHaveAttribute('href', expect.stringContaining('fromManual=m2'));
    expect(within(cur).getByRole('link', { name: 'Create defect from this step' })).toHaveAttribute('href', expect.stringContaining('step=2'));
    expect(within(screen.getByRole('article', { name: 'Step 4' })).queryByRole('group')).toBeNull();

    const queue = screen.getByRole('region', { name: 'Session' });
    expect(within(queue).getByText('SHOP-TC-44')).toBeInTheDocument();
    expect(within(queue).getByText('Passed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish & next case' })).toBeInTheDocument();
  });

  it('records a Fail with the actual result and keeps the step open', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ 'manual.recordStep': () => ({}) });
    const cur = await screen.findByRole('article', { name: 'Step 3' });
    await user.type(within(cur).getByLabelText('Actual result'), 'Cart is empty after reload.');
    await user.click(within(cur).getByRole('button', { name: 'Fail' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'manual.recordStep')).toBeTruthy());
    expect(fake.calls.find((c) => c.path === 'manual.recordStep')?.input).toEqual({
      itemId: 'm2',
      stepIndex: 2,
      verdict: 'fail',
      actual: 'Cart is empty after reload.',
    });
    expect(within(cur).getByRole('button', { name: 'Fail' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(cur).getByRole('button', { name: 'Pass' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('confirms an AI pre-run step', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ 'manual.confirmPreRun': () => ({}) });
    await user.click(within(await screen.findByRole('article', { name: 'Step 2' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'manual.confirmPreRun')?.input).toEqual({ itemId: 'm2', stepIndex: 1 }));
  });

  it('redo turns the pre-run step into the current step', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await screen.findByRole('article', { name: 'Step 2' })).getByRole('button', { name: 'Redo' }));
    expect(within(screen.getByRole('article', { name: 'Step 2' })).getByRole('group', { name: 'Step 2 result' })).toBeInTheDocument();
  });

  it('finishes the case and opens the next one; shows server errors', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { onOpenItem } = renderPage({
      'manual.finish': () => {
        if (fail) {
          fail = false;
          throw new FakeTrpcError('Record a result for every step first (missing: 2, 3, 4)', 'PRECONDITION_FAILED');
        }
        return { caseResultId: 'cr1', verdict: 'failed', nextItemId: 'm3' };
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Finish & next case' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('missing: 2, 3, 4');
    await user.click(screen.getByRole('button', { name: 'Finish & next case' }));
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith('m3'));
  });

  it('turns a note into a draft case', async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({
      'manual.notes.update': () => ({ ok: true }),
      'manual.noteToDraft': () => ({ key: 'SHOP-TC-60', title: 'Coupon hidden', structured: false }),
    });
    const notes = await screen.findByLabelText('Session notes');
    await user.type(notes, 'Coupon hidden on mobile');
    await user.click(screen.getByRole('button', { name: 'Turn note into test case draft' }));
    expect(await screen.findByRole('link', { name: 'SHOP-TC-60' })).toBeInTheDocument();
    expect(fake.calls.find((c) => c.path === 'manual.noteToDraft')?.input).toEqual({ itemId: 'm2', note: 'Coupon hidden on mobile' });
  });

  it('shows an error state when the session cannot be loaded', async () => {
    renderPage({ 'manual.get': () => { throw new FakeTrpcError('Manual item not found: m2', 'NOT_FOUND'); } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Manual item not found');
  });
});
