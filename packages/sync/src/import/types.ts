import type { Assertion, LocatorCandidate, Priority, TestCaseType } from '@s1pilot/domain';
import { S1PilotError } from '@s1pilot/domain';

/** Source formats the importers understand. */
export type ImportFormat = 'csv' | 'gherkin' | 'testrail' | 'xray' | 'zephyr' | 'playwright';

export const IMPORT_FORMATS: readonly ImportFormat[] = ['csv', 'gherkin', 'testrail', 'xray', 'zephyr', 'playwright'];

/** One step of an imported case. */
export interface ImportedStep {
  action: string;
  expected?: string;
  assert?: Assertion[];
}

/** A browser action recovered from a Playwright spec, for a learned script (resolved by the recorder, S-060). */
export interface ImportedAction {
  stepIndex: number;
  action: 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press' | 'hover' | 'goto';
  locators: LocatorCandidate[];
  /** Literal value (never set for secret-looking fields). */
  value?: string;
  url?: string;
}

/** Format-neutral case produced by every importer; always lands as a `draft`. */
export interface ImportedCase {
  /** Stable id in the source system; re-imports update the case with the same ref. */
  externalRef: string;
  title: string;
  /** Folder / section path, outermost first. */
  suitePath: string[];
  priority: Priority;
  type?: TestCaseType;
  tags: string[];
  steps: ImportedStep[];
  parameters: Record<string, string>[];
  actions?: ImportedAction[];
}

/** A source item that could not be converted. */
export interface ImportIssue {
  /** 1-based position in the source (row, scenario, case). */
  index: number;
  title?: string;
  message: string;
}

export interface ParseResult {
  cases: ImportedCase[];
  errors: ImportIssue[];
}

/** Throws a typed error for unreadable import sources. */
export function importError(message: string, details?: Record<string, unknown>): never {
  throw new S1PilotError('IMPORT_INVALID', message, details);
}

const PRIORITY_WORDS: Record<string, Priority> = {
  p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3',
  blocker: 'P0', critical: 'P0', highest: 'P0', urgent: 'P0', '1': 'P0',
  high: 'P1', major: 'P1', '2': 'P1',
  medium: 'P2', normal: 'P2', moderate: 'P2', '3': 'P2',
  low: 'P3', minor: 'P3', lowest: 'P3', trivial: 'P3', '4': 'P3', '5': 'P3',
};

/** Maps free-form priority labels (High, Critical, P1, 2…) to `P0..P3`; unknown values give `P2`. */
export function mapPriority(raw: string | undefined): Priority {
  return PRIORITY_WORDS[(raw ?? '').trim().toLowerCase()] ?? 'P2';
}

/** Splits `1. a\n2. b` (or bullets / plain lines) into items. */
export function splitNumberedLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim())
    .filter((l) => l.length > 0);
}

/** Splits a tag cell on commas, semicolons or whitespace-free separators. */
export function splitTags(text: string | undefined): string[] {
  return [...new Set((text ?? '').split(/[,;\n]/).map((t) => t.trim().replace(/^@/, '')).filter(Boolean))];
}

/** Splits `A/B > C` style paths. */
export function splitPath(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\s*(?:\/|>|\\|›)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
