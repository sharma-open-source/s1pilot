import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, StepKeywordType, type Background, type Examples, type Step } from '@cucumber/messages';

import {
  importError,
  type ImportedCase,
  type ImportedStep,
  type ImportIssue,
  type ParseResult,
} from './types.js';

export interface GherkinOptions {
  /** File name used in external refs so that scenarios of different files do not collide. */
  source?: string;
}

/**
 * Imports a `.feature` file. Each Scenario / Scenario Outline becomes a draft case: Given and When
 * steps become steps, Then steps become the `expected` of the preceding step, Background steps come first,
 * and Examples tables become the case parameters (`<name>` placeholders turn into `{name}`).
 */
export function parseGherkin(text: string, opts: GherkinOptions = {}): ParseResult {
  let doc;
  try {
    doc = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher()).parse(text);
  } catch (e) {
    return importError(`Invalid Gherkin: ${(e as Error).message.split('\n')[0]}`);
  }
  const feature = doc.feature;
  if (!feature) return importError('Gherkin file has no Feature');
  const source = opts.source ?? 'feature';
  const featureTags = feature.tags.map((t) => t.name.replace(/^@/, ''));
  const cases: ImportedCase[] = [];
  const errors: ImportIssue[] = [];
  let background: Background | undefined;
  let index = 0;

  const walk = (children: typeof feature.children, path: string[]): void => {
    for (const ch of children) {
      if (ch.background) background = ch.background;
      if (ch.rule) {
        const saved = background;
        walk(ch.rule.children, [...path, ch.rule.name]);
        background = saved;
      }
      if (!ch.scenario) continue;
      index++;
      const sc = ch.scenario;
      const tags = [...featureTags, ...sc.tags.map((t) => t.name.replace(/^@/, ''))];
      const examples = sc.examples.filter((e) => e.tableHeader);
      const isOutline = examples.length > 0;
      const placeholders = (s: string): string => (isOutline ? s.replace(/<([^<>]+)>/g, '{$1}') : s);
      const steps = stepsOf([...(background?.steps ?? []), ...sc.steps], placeholders);
      if (steps.length === 0) {
        errors.push({ index, title: sc.name, message: 'Scenario has no steps' });
        continue;
      }
      const priority = tags.find((t) => /^P[0-3]$/i.test(t));
      cases.push({
        externalRef: `gherkin:${source}:${[...path, sc.name].join('/')}`,
        title: sc.name || `Scenario ${index}`,
        suitePath: [feature.name || source, ...path].filter(Boolean),
        priority: priority ? (priority.toUpperCase() as 'P0') : 'P2',
        tags: [...new Set(tags.filter((t) => !/^P[0-3]$/i.test(t)))],
        steps,
        parameters: examples.flatMap(rowsOf),
      });
    }
  };
  walk(feature.children, []);
  return { cases, errors };
}

function rowsOf(ex: Examples): Record<string, string>[] {
  const header = ex.tableHeader?.cells.map((c) => c.value) ?? [];
  return ex.tableBody.map((r) => Object.fromEntries(header.map((h, i) => [h, r.cells[i]?.value ?? ''])));
}

function stepsOf(steps: readonly Step[], fix: (s: string) => string): ImportedStep[] {
  const out: ImportedStep[] = [];
  let kind: StepKeywordType | undefined;
  for (const s of steps) {
    if (s.keywordType && s.keywordType !== StepKeywordType.CONJUNCTION && s.keywordType !== StepKeywordType.UNKNOWN) kind = s.keywordType;
    const text = fix(s.text);
    if (kind === StepKeywordType.OUTCOME) {
      const last = out[out.length - 1];
      if (last) last.expected = last.expected ? `${last.expected}; ${text}` : text;
      else out.push({ action: 'Check the result', expected: text });
    } else out.push({ action: text });
  }
  return out;
}
