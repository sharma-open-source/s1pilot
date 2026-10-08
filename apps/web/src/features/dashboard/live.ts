import { useEffect, useState } from 'react';

import { applyRunMessage, type LiveStep } from './model';

import { subscribeWorkspace } from '@/lib/nav-data';
import { trpc } from '@/lib/trpc';

/** Invalidates the dashboard queries whenever `/ws/workspace` reports a count or run status change. */
export function useDashboardLiveUpdates(): void {
  const utils = trpc.useUtils();
  useEffect(
    () =>
      subscribeWorkspace(() => {
        void utils.dashboard.summary.invalidate();
        void utils.runs.recent.invalidate();
        void utils.projects.list.invalidate();
      }),
    [utils],
  );
}

/**
 * Follows `/ws/runs/:runId` while `enabled` and returns the step in progress. A new case refreshes
 * `runs.recent` so the row's step total (`y` of `step x/y`) follows the case that is running.
 */
export function useLiveStep(runId: string, enabled: boolean): LiveStep {
  const [state, setState] = useState<LiveStep>({ current: null });
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let closed = false;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws/runs/${encodeURIComponent(runId)}`);
    } catch {
      return;
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (closed || typeof ev.data !== 'string') return; // binary frames are screencast
      try {
        const message: unknown = JSON.parse(ev.data);
        setState((s) => applyRunMessage(s, message));
        const type = (message as { event?: { type?: unknown } }).event?.type;
        if (type === 'case.started' || type === 'case.finished') void utils.runs.recent.invalidate();
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => {
      closed = true;
      ws?.close();
    };
  }, [enabled, runId, utils]);
  return state;
}
