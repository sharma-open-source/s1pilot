import type { RunEvent } from '@s1pilot/domain';

/** Receives every run event published on the bus. */
export type RunEventListener = (event: RunEvent) => void;

/**
 * In-process publish/subscribe for run events (`run.started`, `case.started`, `step.finished`, …).
 * The WebSocket gateway (S-036) subscribes to it; listener errors never reach publishers.
 */
export class RunEventBus {
  private readonly listeners = new Set<RunEventListener>();

  /** Subscribes to all events; returns the unsubscribe function. */
  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Delivers an event to all current listeners, synchronously and in subscription order. */
  emit(event: RunEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must not break run execution.
      }
    }
  }
}
