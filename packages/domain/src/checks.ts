import { z } from 'zod';

import type { PlanChecks } from './plan.js';

/** axe-core impact levels, lowest first. */
export const A11Y_IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const;
export const A11yImpactSchema = z.enum(A11Y_IMPACTS);
export type A11yImpact = z.infer<typeof A11yImpactSchema>;

/** True when `impact` is at least as severe as `threshold`. */
export function impactAtLeast(impact: A11yImpact, threshold: A11yImpact): boolean {
  return A11Y_IMPACTS.indexOf(impact) >= A11Y_IMPACTS.indexOf(threshold);
}

export const CheckKindSchema = z.enum(['a11y', 'console', 'network']);
export type CheckKind = z.infer<typeof CheckKindSchema>;

/** `pass`: nothing flagged; `warn`: flagged, verdict unchanged; `fail`: flagged and fails the case. */
export const CheckSeveritySchema = z.enum(['pass', 'warn', 'fail']);
export type CheckSeverity = z.infer<typeof CheckSeveritySchema>;

/** One flagged thing: an axe violation node, a console error or a failing request. */
export const CheckItemSchema = z.object({
  /** Short human text (axe help, console message, `GET /x -> 503`). */
  summary: z.string(),
  /** Whether this single item makes the check fail (a11y: impact at or above the threshold). */
  severity: z.enum(['warn', 'fail']),
  /** axe rule id (`label`). */
  ruleId: z.string().optional(),
  impact: A11yImpactSchema.optional(),
  /** CSS selector of the offending element (a11y). */
  target: z.string().optional(),
  helpUrl: z.string().optional(),
  /** Page URL (a11y) or request URL (network) or script location (console). */
  url: z.string().optional(),
  /** 0-based index of the step after which the item was found. */
  stepIndex: z.number().int().min(0).optional(),
  /** HTTP status (network). */
  status: z.number().int().optional(),
  /** Console message type / request failure. */
  type: z.string().optional(),
});
export type CheckItem = z.infer<typeof CheckItemSchema>;

/** Result of one check on a case result (stored as `checks.json` evidence). */
export const CheckResultSchema = z.object({
  kind: CheckKindSchema,
  severity: CheckSeveritySchema,
  items: z.array(CheckItemSchema).default([]),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Compact form kept on the case result row: enough for the warning pill and the tab counts. */
export const CheckSummarySchema = z.object({ kind: CheckKindSchema, severity: CheckSeveritySchema, count: z.number().int().min(0) });
export type CheckSummary = z.infer<typeof CheckSummarySchema>;

/** Summaries of `checks`. */
export function summarizeChecks(checks: readonly CheckResult[]): CheckSummary[] {
  return checks.map((c) => ({ kind: c.kind, severity: c.severity, count: c.items.length }));
}

/** True when any check is a warning (the result shows a warning pill). */
export const hasCheckWarnings = (checks: readonly { severity: CheckSeverity }[] | undefined): boolean =>
  (checks ?? []).some((c) => c.severity === 'warn');

/**
 * Runner configuration of the checks, derived from the plan's `PlanChecks`. `console` / `network` are always
 * collected (the logs exist anyway): `fail` when the plan says "fail on console errors", else `warn`.
 */
export interface CheckConfig {
  a11y?: { failImpact: A11yImpact; disabledRules: string[] } | undefined;
  console: { mode: 'warn' | 'fail'; allow: string[] };
  network: { mode: 'warn' | 'fail'; allow: string[]; thirdParty: boolean };
}

/** Console messages ignored by default: favicon requests, and resource-load failures (the network check reports those). */
export const DEFAULT_CONSOLE_ALLOW: readonly string[] = ['favicon\\.ico', 'Failed to load resource'];

/**
 * Runner configuration for a plan's checks. Console and network health are always collected for plan runs
 * (`consoleErrors` picks fail or warn); the accessibility scan runs only when `a11y` is on.
 */
export function checkConfigFromPlan(checks: PlanChecks): CheckConfig {
  const mode = checks.consoleErrors ? 'fail' : 'warn';
  return {
    ...(checks.a11y ? { a11y: { failImpact: checks.a11yFailImpact ?? 'serious', disabledRules: checks.a11yDisabledRules ?? [] } } : {}),
    console: { mode, allow: [...DEFAULT_CONSOLE_ALLOW, ...(checks.consoleAllow ?? [])] },
    network: { mode, allow: checks.networkAllow ?? [], thirdParty: checks.networkThirdParty ?? false },
  };
}

/** Case-insensitive match of `text` against the regex strings in `patterns`; invalid patterns are ignored. */
export function matchesAllowList(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}
