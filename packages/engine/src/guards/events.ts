/** Emitted when a guard blocks a request or navigation (`guard.blocked`). */
export interface GuardBlockedEvent {
  type: 'guard.blocked';
  guard: 'domain' | 'read-only';
  url: string;
  method: string;
  resourceType: string;
  reason: string;
  /** ISO-8601 UTC timestamp. */
  at: string;
}

/** Receives guard events. */
export type GuardEventSink = (event: GuardBlockedEvent) => void;

/** Handle returned by the route-based guards. */
export interface InstalledGuard {
  /** Every event this guard has emitted so far. */
  readonly blocked: readonly GuardBlockedEvent[];
  /** Removes the route handler. */
  dispose(): Promise<void>;
}
