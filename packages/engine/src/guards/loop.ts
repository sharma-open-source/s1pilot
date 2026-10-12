/** Limits for {@link LoopGuard}. */
export interface LoopLimits {
  /** Identical consecutive fingerprint+action count that means "stuck". Default 3. */
  maxRepeats?: number;
  /** Max actions within one case step. Default 15. */
  maxStepsPerCaseStep?: number;
  /** Max actions per case. Default 100. */
  maxStepsPerCase?: number;
  /** Wall-clock budget per case in ms. Default 300000 (5 min). */
  maxWallClockMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Why the loop guard stopped a case. */
export type LoopVerdict =
  | { ok: true }
  | { ok: false; reason: 'stuck' | 'step-limit' | 'case-limit' | 'timeout'; message: string };

/**
 * Tracks the actions of one case. Call {@link LoopGuard.beginCaseStep} when a new case step
 * starts and {@link LoopGuard.record} before executing each action with the page fingerprint
 * (see `pageFingerprint`) and a stable action key (see {@link actionKey}).
 */
export class LoopGuard {
  private readonly maxRepeats: number;
  private readonly maxStep: number;
  private readonly maxCase: number;
  private readonly budget: number;
  private readonly now: () => number;
  private readonly started: number;
  private stepCount = 0;
  private caseCount = 0;
  private last: string | undefined;
  private streak = 0;

  constructor(limits: LoopLimits = {}) {
    this.maxRepeats = limits.maxRepeats ?? 3;
    this.maxStep = limits.maxStepsPerCaseStep ?? 15;
    this.maxCase = limits.maxStepsPerCase ?? 100;
    this.budget = limits.maxWallClockMs ?? 5 * 60_000;
    this.now = limits.now ?? Date.now;
    this.started = this.now();
  }

  /** Resets the per-case-step counters. */
  beginCaseStep(): void {
    this.stepCount = 0;
    this.last = undefined;
    this.streak = 0;
  }

  /** Records an about-to-run action; returns a failing verdict when a limit is hit. */
  record(fingerprint: string, action: string): LoopVerdict {
    if (this.now() - this.started > this.budget) {
      return { ok: false, reason: 'timeout', message: `Case exceeded its ${this.budget} ms budget` };
    }
    this.caseCount += 1;
    this.stepCount += 1;
    const key = `${fingerprint}\u0000${action}`;
    this.streak = key === this.last ? this.streak + 1 : 1;
    this.last = key;
    if (this.streak >= this.maxRepeats) {
      return { ok: false, reason: 'stuck', message: `Same state and action repeated ${this.streak} times` };
    }
    if (this.stepCount > this.maxStep) {
      return { ok: false, reason: 'step-limit', message: `More than ${this.maxStep} actions in one step` };
    }
    if (this.caseCount > this.maxCase) {
      return { ok: false, reason: 'case-limit', message: `More than ${this.maxCase} actions in one case` };
    }
    return { ok: true };
  }
}

/** Stable key for an action: kind plus target and value reference (never literal values). */
export function actionKey(action: { kind: string } & Record<string, unknown>): string {
  const { kind, locators, url, key, dir, label, valueRef, fileRef, target } = action;
  const drop = (target as { locators?: unknown } | undefined)?.locators ?? null;
  return JSON.stringify([kind, locators ?? null, url ?? null, key ?? null, dir ?? null, label ?? null, valueRef ?? fileRef ?? null, drop]);
}
