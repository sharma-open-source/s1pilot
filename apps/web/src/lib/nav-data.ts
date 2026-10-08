import { useEffect, useState } from 'react';

import { trpc } from './trpc';

/** Minimal project shape the nav needs (a subset of the `projects.list` output). */
export interface NavProject {
  key: string;
  name: string;
}

/** Reachability of one model endpoint; `unknown` until `models.status` answers. */
export interface ModelRow {
  /** Model id, e.g. `clef-flash`. */
  model: string;
  /** Adapter name or host, e.g. `localhost:8000`. */
  endpoint: string;
  reachable: boolean | 'unknown';
}

/** Nav view of the `models.status` output. */
export interface ModelsStatus {
  s1: ModelRow | null;
  s2: ModelRow | null;
}

export interface WorkspaceBadges {
  liveRuns: number;
  reviewCount: number;
}

export const EMPTY_MODELS: ModelsStatus = { s1: null, s2: null };
export const EMPTY_BADGES: WorkspaceBadges = { liveRuns: 0, reviewCount: 0 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Accepts an array of `{key, name}` and drops anything else. */
export function parseProjects(raw: unknown): NavProject[] {
  if (!Array.isArray(raw)) return [];
  const out: NavProject[] = [];
  for (const p of raw) {
    if (isRecord(p) && typeof p['key'] === 'string' && typeof p['name'] === 'string') {
      out.push({ key: p['key'], name: p['name'] });
    }
  }
  return out;
}

function parseModelRow(raw: unknown): ModelRow | null {
  if (!isRecord(raw)) return null;
  if (raw['configured'] === false) return null;
  const model = raw['model'] ?? raw['name'];
  const endpoint = raw['endpoint'] ?? raw['baseUrl'] ?? raw['adapter'];
  const reachable = raw['reachable'] ?? raw['ok'];
  return {
    model: typeof model === 'string' ? model : 'unknown',
    endpoint: typeof endpoint === 'string' ? endpoint : '',
    reachable: typeof reachable === 'boolean' ? reachable : 'unknown',
  };
}

/** Tolerant parser for `models.status` output. */
export function parseModelsStatus(raw: unknown): ModelsStatus {
  if (!isRecord(raw)) return EMPTY_MODELS;
  return { s1: parseModelRow(raw['s1'] ?? raw['system1']), s2: parseModelRow(raw['s2'] ?? raw['system2']) };
}

/** Tolerant parser for `/ws/workspace` badge messages. */
export function parseBadges(raw: unknown): Partial<WorkspaceBadges> {
  if (!isRecord(raw)) return {};
  const src = isRecord(raw['badges']) ? raw['badges'] : raw;
  const out: Partial<WorkspaceBadges> = {};
  if (typeof src['liveRuns'] === 'number') out.liveRuns = src['liveRuns'];
  if (typeof src['reviewCount'] === 'number') out.reviewCount = src['reviewCount'];
  return out;
}

/** Projects for the switcher; `data` is an empty list while `projects.list` is failing. */
export function useProjects() {
  const q = trpc.projects.list.useQuery(undefined, { select: parseProjects });
  return { ...q, data: q.data ?? [] };
}

/** S1/S2 reachability for the nav footer; empty while `models.status` is failing. */
export function useModelsStatus() {
  const q = trpc.models.status.useQuery(undefined, { refetchInterval: 30_000, select: parseModelsStatus });
  return { ...q, data: q.data ?? EMPTY_MODELS };
}

/**
 * Live-run and review counts from `/ws/workspace`. Stays at 0 when the socket is absent; reconnects with backoff.
 * TODO(S-036): confirm the message shape once the workspace websocket exists.
 */
export function useWorkspaceBadges(enabled = true): WorkspaceBadges {
  const [badges, setBadges] = useState<WorkspaceBadges>(EMPTY_BADGES);
  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2_000;
    let closed = false;
    const connect = () => {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${window.location.host}/ws/workspace`);
      } catch {
        return;
      }
      ws.onopen = () => {
        delay = 2_000;
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const patch = parseBadges(JSON.parse(String(ev.data)));
          setBadges((b) => ({ ...b, ...patch }));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      ws?.close();
    };
  }, [enabled]);
  return badges;
}
