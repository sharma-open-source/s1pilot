import type { RunControlMessage } from '@s1pilot/domain';
import { useCallback, useEffect, useRef, useState } from 'react';

import { applyMessage, decodeFrameBytes, INITIAL_LIVE_STATE, type LiveRunState } from './model';

/** Latest screencast frame as an object URL plus its viewport size. */
export interface FrameView {
  url: string;
  width: number;
  height: number;
  seq: number;
}

export type Connection = 'connecting' | 'open' | 'reconnecting';

export interface RunSocket {
  state: LiveRunState;
  /** Latest frame of any case. */
  frame: FrameView | null;
  /** Latest frame per case result id (one per parallel browser), at most {@link MAX_FRAMES}. */
  frames: Readonly<Record<string, FrameView>>;
  connection: Connection;
  /** Sends a control message; `false` when the socket is not open (use `runs.control` instead). */
  send: (message: RunControlMessage) => boolean;
}

/** Most cases whose last frame is kept; the least recently updated one is dropped first. */
export const MAX_FRAMES = 16;

/** Reconnect delay: 500 ms doubling up to 10 s. */
export function backoffDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}

/**
 * Follows `/ws/runs/:runId`: applies the snapshot and events to {@link LiveRunState}, turns binary frames into
 * object URLs, and reconnects with exponential backoff (every reconnect starts again from a fresh snapshot).
 */
export function useRunSocket(runId: string): RunSocket {
  const [state, setState] = useState<LiveRunState>(INITIAL_LIVE_STATE);
  const [frame, setFrame] = useState<FrameView | null>(null);
  const [frames, setFrames] = useState<Readonly<Record<string, FrameView>>>({});
  const [connection, setConnection] = useState<Connection>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const finishedRef = useRef(false);
  finishedRef.current = state.finished !== null;

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Insertion order = least recently updated first; each object URL is revoked once its frame is replaced.
    const latest = new Map<string, FrameView>();
    const revoke = (url: string): void => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    };
    setState(INITIAL_LIVE_STATE);
    setFrame(null);
    setFrames({});

    const putFrame = (resultId: string, next: FrameView): void => {
      const old = latest.get(resultId);
      if (old !== undefined) revoke(old.url);
      latest.delete(resultId);
      latest.set(resultId, next);
      while (latest.size > MAX_FRAMES) {
        const [oldestId, oldest] = latest.entries().next().value as [string, FrameView];
        revoke(oldest.url);
        latest.delete(oldestId);
      }
      setFrame(next);
      setFrames(Object.fromEntries(latest));
    };

    const connect = (): void => {
      if (closed) return;
      let ws: WebSocket;
      try {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${window.location.host}/ws/runs/${encodeURIComponent(runId)}`);
      } catch {
        timer = setTimeout(connect, backoffDelay(attempt++));
        return;
      }
      ws.binaryType = 'arraybuffer';
      socketRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnection('open');
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (closed) return;
        if (typeof ev.data === 'string') {
          try {
            const message: unknown = JSON.parse(ev.data);
            setState((s) => applyMessage(s, message));
          } catch {
            /* ignore malformed messages */
          }
          return;
        }
        if (ev.data instanceof ArrayBuffer && typeof URL.createObjectURL === 'function') {
          const decoded = decodeFrameBytes(ev.data);
          if (decoded === null) return;
          const url = URL.createObjectURL(new Blob([ev.data.slice(ev.data.byteLength - decoded.jpeg.byteLength)], { type: 'image/jpeg' }));
          putFrame(decoded.resultId, { url, width: decoded.width, height: decoded.height, seq: decoded.seq });
        }
      };
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        if (closed || finishedRef.current) return;
        setConnection('reconnecting');
        timer = setTimeout(connect, backoffDelay(attempt++));
      };
      ws.onerror = () => ws.close();
    };

    setConnection('connecting');
    connect();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
      for (const f of latest.values()) revoke(f.url);
      latest.clear();
      setFrame(null);
      setFrames({});
    };
  }, [runId]);

  const send = useCallback((message: RunControlMessage): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  return { state, frame, frames, connection, send };
}
