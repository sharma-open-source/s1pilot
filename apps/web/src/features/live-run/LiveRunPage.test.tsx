import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveRunPage } from './LiveRunPage';
import { applyMessage, buildDecisionView, decodeFrameBytes, describeEvent, INITIAL_LIVE_STATE, progressCounts, stepMode } from './model';
import { backoffDelay } from './useRunSocket';

import { createFakeTrpc, FakeTrpcProvider, type Handler } from '@/test/fake-trpc';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

const TS = '2026-10-08T10:00:01.000Z';
const RUN = { id: 'run-1234567', projectId: 'p1', trigger: 'manual', status: 'running', summary: { passed: 0, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 } };
const ESC = {
  type: 'escalation.needed',
  runId: RUN.id,
  ts: TS,
  caseResultId: 'cr1',
  stepIndex: 2,
  escalationId: 'esc-1',
  reason: 'low-confidence',
  to: 'human',
  options: ['e3', 'e7', 'e2', 'scroll_down', 'stuck', 'e9'],
  question: 'which element performs “Go to checkout as guest”?',
  probabilities: { e3: 0.62, e7: 0.21, e2: 0.09, scroll_down: 0.05, stuck: 0.02, e9: 0.01 },
  optionLabels: { e3: 'Checkout as guest', e7: 'Sign in to check out', e2: 'Continue shopping' },
  s2Choice: 'e3',
  thresholds: { act: 0.8 },
  detail: 'Waiting for your approval because the plan is attended.',
};
const SNAPSHOT = {
  type: 'snapshot',
  run: RUN,
  currentCase: { caseResultId: 'cr1', caseId: 'c1', caseKey: 'SHOP-TC-42' },
  steps: [
    { stepIndex: 0, action: 'Open Classic Tee', status: 'passed' },
    { stepIndex: 1, action: 'Pick colour & size', status: 'passed' },
    { stepIndex: 2, action: 'Checkout as guest', status: 'running' },
  ],
  lastDecision: null,
  pendingEscalations: [ESC],
};

function handlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'runs.get': () => ({
      ...RUN,
      config: { environmentId: 'e1', environment: 'staging', browser: 'chromium', mode: 'replay-heal', attended: true },
      jobs: [
        { id: 'j1', status: 'running', attempts: 1, caseId: 'c1', caseKey: 'SHOP-TC-42' },
        { id: 'j2', status: 'queued', attempts: 0, caseId: 'c2', caseKey: 'SHOP-TC-43' },
      ],
      progress: { total: 2, queued: 1, running: 1, completed: 0, failed: 0, cancelled: 0 },
      results: [],
    }),
    'cases.get': () => ({
      key: 'SHOP-TC-42',
      title: 'Guest can check out',
      steps: [{ action: 'Open Classic Tee' }, { action: 'Pick colour & size' }, { action: 'Checkout as guest' }, { action: 'Stop before payment' }],
    }),
    'runs.control': () => ({ ok: true }),
    'runs.cancel': () => RUN,
    ...over,
  };
}

function renderPage(over: Record<string, Handler> = {}) {
  const fake = createFakeTrpc(handlers(over));
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <LiveRunPage projectKey="SHOP" runId={RUN.id} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <FakeTrpcProvider fake={fake}>
      <RouterProvider router={router} />
    </FakeTrpcProvider>,
  );
  return fake;
}

async function connected(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeSocket.instances.at(-1) as FakeSocket;
  act(() => ws.open());
  return ws;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveRunPage', () => {
  it('shows options with probabilities for a low-confidence escalation and Approve sends the choice', async () => {
    const user = userEvent.setup();
    renderPage();
    const ws = await connected();
    act(() => ws.push(SNAPSHOT));

    const panel = await screen.findByRole('region', { name: 'System 1 decision' });
    expect(panel).toHaveAttribute('aria-live', 'polite');
    expect(within(panel).getByText('Decision · step 3')).toBeInTheDocument();
    expect(within(panel).getByText('e3 · Checkout as guest')).toBeInTheDocument();
    expect(within(panel).getByText('0.62')).toBeInTheDocument();
    expect(within(panel).getAllByTestId('probability-bar')).toHaveLength(5);
    expect(within(panel).getByText('Below act threshold (0.80)')).toBeInTheDocument();
    expect(within(panel).getByText(/System 2 asked → also picks e3/)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Approve e3' }));
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: 'approve', escalationId: 'esc-1', choice: 'e3', saveToLearned: true });

    // The run resumes: the server resolves the escalation and the panel goes idle.
    act(() => ws.push({ type: 'event', event: { type: 'escalation.resolved', runId: RUN.id, ts: TS, escalationId: 'esc-1', resolution: 'approved', by: 'human', chosen: 'e3' } }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve e3' })).not.toBeInTheDocument());
  });

  it('picks another option from the full list incl. meta actions, skips with S, and honours the save checkbox', async () => {
    const user = userEvent.setup();
    renderPage();
    const ws = await connected();
    act(() => ws.push(SNAPSHOT));
    const panel = await screen.findByRole('region', { name: 'System 1 decision' });

    await user.click(within(panel).getByLabelText('Save approved choice into learned script'));
    await user.click(within(panel).getByRole('button', { name: 'Approve e3' }));
    expect(JSON.parse(ws.sent.at(-1) as string)).toMatchObject({ type: 'approve', saveToLearned: false });

    await user.click(within(panel).getByRole('button', { name: 'Pick another' }));
    const list = within(panel).getByRole('list', { name: 'All options' });
    expect(within(list).getAllByRole('button')).toHaveLength(6); // includes e9, stuck, scroll_down
    await user.click(within(list).getByRole('button', { name: /^stuck/ }));
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: 'pickOther', escalationId: 'esc-1', choice: 'stuck' });

    within(panel).getByRole('button', { name: 'Approve e3' }).focus();
    await user.keyboard('s');
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: 'skipStep' });
    await user.keyboard('a');
    expect(JSON.parse(ws.sent.at(-1) as string)).toMatchObject({ type: 'approve', choice: 'e3' });
  });

  it('restores steps, up next and header from the snapshot (reload mid-run)', async () => {
    renderPage();
    const ws = await connected();
    act(() => ws.push(SNAPSHOT));
    const steps = await screen.findByRole('region', { name: 'Steps of current case' });
    expect(within(steps).getByText('1 · Open Classic Tee')).toBeInTheDocument();
    expect(within(steps).getByText('3 · Checkout as guest').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(await within(steps).findByText('4 · Stop before payment')).toBeInTheDocument();
    expect(await within(steps).findByText('SHOP-TC-43')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: `SHOP-TC-42 · run #${RUN.id.slice(-6)}` })).toBeInTheDocument();
    expect(await screen.findByText(/staging · Chromium · case 1 of 2/)).toBeInTheDocument();
  });

  it('pauses, takes over and aborts after confirmation', async () => {
    const user = userEvent.setup();
    const fake = renderPage();
    const ws = await connected();
    act(() => ws.push({ ...SNAPSHOT, pendingEscalations: [] }));
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: 'pause' });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Take over browser' }));
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: 'takeover' });
    expect(screen.getByRole('button', { name: 'Release control' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Abort' }));
    expect(fake.calls.some((c) => c.path === 'runs.cancel')).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Abort run' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === 'runs.cancel')).toBe(true));
  });

  it('falls back to runs.control when the socket is not open', async () => {
    const user = userEvent.setup();
    const fake = renderPage();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const ws = FakeSocket.instances[0] as FakeSocket;
    act(() => ws.push({ ...SNAPSHOT, pendingEscalations: [] })); // never opened
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(fake.calls.find((c) => c.path === 'runs.control')?.input).toEqual({ runId: RUN.id, message: { type: 'pause' } }));
  });

  it('logs events (escalations highlighted), toggles boxes and shows the report banner on run.finished', async () => {
    const user = userEvent.setup();
    renderPage();
    const ws = await connected();
    act(() => ws.push({ ...SNAPSHOT, pendingEscalations: [] }));
    const events = [
      { type: 'observation.elements', runId: RUN.id, ts: TS, caseResultId: 'cr1', stepIndex: 2, chosenId: 'e3', elements: [{ id: 'e3', role: 'button', label: 'Checkout as guest', box: { x: 100, y: 200, w: 300, h: 40 } }, { id: 'e2', role: 'link', label: 'Continue shopping', box: { x: 10, y: 20, w: 100, h: 30 } }] },
      ESC,
      { type: 'log', runId: RUN.id, ts: TS, level: 'warn', message: 'console: Failed to load https://staging.shop.example/cart.js' },
    ];
    for (const event of events) act(() => ws.push({ type: 'event', event }));

    const log = await screen.findByRole('log', { name: 'Run events' });
    expect(within(log).getByText(/awaiting approval/)).toHaveClass('text-warning-log');
    expect(within(log).getByText(/^\[10:00:01\] observe · 2 elements/)).toBeInTheDocument();
    expect(screen.getByText('https://staging.shop.example/cart.js')).toBeInTheDocument();

    const chosen = document.querySelector('[data-element="e3"]');
    expect(chosen).toHaveAttribute('data-chosen', 'true');
    expect(document.querySelector('[data-element="e2"]')).not.toHaveAttribute('data-chosen');
    expect(screen.getByText('2 interactive elements · numbered boxes shown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Toggle element boxes' }));
    expect(document.querySelector('[data-element="e3"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Console · Network' }));
    expect(within(screen.getByRole('log', { name: 'Console output' })).getByText(/Failed to load/)).toBeInTheDocument();

    act(() =>
      ws.push({ type: 'event', event: { type: 'run.finished', runId: RUN.id, ts: TS, status: 'passed', summary: { passed: 2, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 } } }),
    );
    const link = await screen.findByRole('link', { name: 'Open report' });
    expect(link).toHaveAttribute('href', `/p/SHOP/runs/${RUN.id}`);
  });

  it('reconnects with backoff and shows a reconnecting notice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage();
      const ws = await connected();
      act(() => ws.push(SNAPSHOT));
      act(() => ws.close());
      expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(FakeSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('live-run model', () => {
  it('backs off exponentially up to 10 s', () => {
    expect([0, 1, 2, 3, 10].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 10_000]);
  });

  it('decodes the binary frame layout', () => {
    const id = new TextEncoder().encode('cr1');
    const bytes = new Uint8Array(9 + id.length + 2);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, id.length);
    view.setUint32(1, 7);
    view.setUint16(5, 1280);
    view.setUint16(7, 720);
    bytes.set(id, 9);
    bytes.set([0xff, 0xd8], 9 + id.length);
    expect(decodeFrameBytes(bytes.buffer)).toMatchObject({ resultId: 'cr1', seq: 7, width: 1280, height: 720 });
    expect(decodeFrameBytes(new ArrayBuffer(4))).toBeNull();
  });

  it('labels decided steps of an exploring case "explore", even under a replay-heal plan', () => {
    const decided = { index: 0, action: 'a', status: 'running' as const, decided: true };
    expect(stepMode(decided, 'replay-heal', 'explore')).toBe('explore');
    expect(stepMode(decided, 'replay-heal', 'replay')).toBe('heal');
    expect(stepMode({ ...decided, decided: false }, 'replay-heal', 'replay')).toBe('replay');
  });

  it('builds a read-only view from the last decision and counts progress', () => {
    const state = applyMessage(applyMessage(INITIAL_LIVE_STATE, { ...SNAPSHOT, pendingEscalations: [] }), {
      type: 'event',
      event: { type: 'decision.made', runId: RUN.id, ts: TS, caseResultId: 'cr1', stepIndex: 2, decision: { questionId: 'q', options: ['e1', 'e2'], probabilities: { e1: 0.9, e2: 0.1 }, chosen: 'e1', confidence: 0.9, model: 'clef', latencyMs: 12 } },
    });
    const view = buildDecisionView(state);
    expect(view).toMatchObject({ step: 3, model: 'clef', escalationId: null, approveId: null });
    expect(view?.rows.map((r) => r.id)).toEqual(['e1', 'e2']);
    expect(progressCounts([{ verdict: 'passed' }, { verdict: 'failed' }, { verdict: 'needs-review' }], 5)).toEqual({ passed: 1, failed: 1, review: 1, queued: 2, total: 5 });
    expect(describeEvent({ type: 'run.started', runId: 'r', ts: TS, totalCases: 1 }, undefined).text).toBe('run started · 1 case');
  });
});
