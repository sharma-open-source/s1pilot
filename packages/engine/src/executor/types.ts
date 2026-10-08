import type { LocatorCandidate } from '@s1pilot/domain';
import type { Page } from 'playwright';

import type { StableWaitOptions } from './waits.js';

/** Where an element-targeting action is aimed: ordered locator candidates (most robust first). */
export interface ActionTarget {
  locators: readonly LocatorCandidate[];
  /** Name (or url) of the iframe the element lives in, as reported by the observer. */
  frame?: string;
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';

/** An action the executor can perform. Values are always references (`secret:`, `var:`, `input:`). */
export type EngineAction =
  | ({ kind: 'click' } & ActionTarget)
  | ({ kind: 'fill'; valueRef: string } & ActionTarget)
  | ({ kind: 'selectOption'; label?: string; valueRef?: string } & ActionTarget)
  | ({ kind: 'check' } & ActionTarget)
  | ({ kind: 'uncheck' } & ActionTarget)
  | { kind: 'press'; key: string; locators?: readonly LocatorCandidate[]; frame?: string }
  | ({ kind: 'hover' } & ActionTarget)
  | { kind: 'scroll'; dir: ScrollDirection; locators?: readonly LocatorCandidate[]; frame?: string }
  | { kind: 'goBack' }
  | { kind: 'goto'; url: string }
  | ({ kind: 'upload'; fileRef: string } & ActionTarget);

/** Execution context supplied by the caller (engine loop, runner, tests). */
export interface ExecutorContext {
  /**
   * Resolves a value reference to its literal string. Called at the last moment; the result is
   * never stored in the outcome. Required for `fill`, `selectOption` by `valueRef`, and `upload`.
   */
  resolveValue?: (ref: string) => string | Promise<string>;
  /** When true, JS dialogs are dismissed instead of accepted (guarded run). */
  guardDialogs?: boolean;
  /** Directory for downloads; a fresh temp directory is created on first download when omitted. */
  downloadDir?: string;
  /** Per-attempt action timeout in ms (default 5000). */
  actionTimeoutMs?: number;
  /** Settle-wait options applied after the action (replay uses a shorter quiet period). */
  stable?: StableWaitOptions;
}

export interface DialogRecord {
  type: string;
  message: string;
  accepted: boolean;
}

export interface DownloadRecord {
  suggestedFilename: string;
  /** Saved path on disk. */
  path: string;
}

export interface NewPageRecord {
  page: Page;
  url: string;
}

export interface ActionError {
  code: 'locator_not_found' | 'timeout' | 'detached' | 'missing_value' | 'action_failed';
  message: string;
}

/** Result of `execute`. Never contains resolved values, only `valueRef`. */
export interface ActionOutcome {
  ok: boolean;
  /** The locator candidate that performed the action (element-targeting actions). */
  usedLocator?: LocatorCandidate;
  /** True when the main frame navigated (or the URL changed) during the action. */
  navigated: boolean;
  /** Popup / new tab opened by the action; the caller should switch to it. */
  newPage?: NewPageRecord;
  dialog?: DialogRecord;
  download?: DownloadRecord;
  valueRef?: string;
  error?: ActionError;
  durationMs: number;
}
