import { parseCsvCases } from './csv.js';
import {
  importError,
  mapPriority,
  splitNumberedLines,
  splitTags,
  type ImportedCase,
  type ImportedStep,
  type ImportIssue,
  type ParseResult,
} from './types.js';
import { child, childrenOf, parseXml, textOf, type XmlNode } from './xml.js';

/**
 * Imports a TestRail export: the XML suite export (`<suite><sections><section>…<cases><case>`) or the CSV
 * export. Sections become suites (nested sections give nested suites).
 */
export function parseTestRail(text: string): ParseResult {
  const t = text.trimStart();
  if (!t.startsWith('<')) return prefixRefs(parseCsvCases(text), 'testrail');
  const root = parseXml(text);
  const cases: ImportedCase[] = [];
  const errors: ImportIssue[] = [];
  let n = 0;

  const walkSection = (section: XmlNode, path: string[]): void => {
    const name = textOf(section, 'name');
    const here = name ? [...path, name] : path;
    for (const c of childrenOf(child(section, 'cases') ?? section, 'case')) {
      n++;
      const title = textOf(c, 'title');
      const id = textOf(c, 'id');
      if (!title) {
        errors.push({ index: n, message: 'Case has no title' });
        continue;
      }
      const steps = stepsOf(c);
      if (steps.length === 0) {
        errors.push({ index: n, title, message: 'Case has no steps' });
        continue;
      }
      const custom = child(c, 'custom');
      const preconds = custom ? textOf(custom, 'preconds') : '';
      cases.push({
        externalRef: `testrail:${id || `${here.join('/')}/${title}`}`,
        title,
        suitePath: here,
        priority: mapPriority(textOf(c, 'priority')),
        tags: splitTags(textOf(c, 'references')),
        steps: preconds ? [{ action: `Precondition: ${preconds}` }, ...steps] : steps,
        parameters: [],
      });
    }
    for (const sub of childrenOf(child(section, 'sections') ?? section, 'section')) walkSection(sub, here);
  };

  const sectionsOf = (n: XmlNode): XmlNode[] => childrenOf(child(n, 'sections') ?? n, 'section');
  const tops: XmlNode[] =
    root.name === 'section'
      ? [root]
      : root.name === 'suites'
        ? childrenOf(root, 'suite').flatMap(sectionsOf)
        : sectionsOf(root);
  if (tops.length === 0) importError('Not a TestRail XML export (no sections found)');
  for (const s of tops) walkSection(s, []);
  return { cases, errors };
}

function stepsOf(c: XmlNode): ImportedStep[] {
  const custom = child(c, 'custom');
  if (!custom) return [];
  const separated = child(custom, 'steps_separated');
  if (separated) {
    return childrenOf(separated, 'step')
      .map((s) => ({ action: textOf(s, 'content'), expected: textOf(s, 'expected') }))
      .filter((s) => s.action !== '')
      .map((s) => ({ action: s.action, ...(s.expected ? { expected: s.expected } : {}) }));
  }
  const actions = splitNumberedLines(textOf(custom, 'steps'));
  const expected = splitNumberedLines(textOf(custom, 'expected'));
  if (actions.length <= 1 && expected.length > 1) {
    return actions.map((a) => ({ action: a, expected: expected.join('; ') }));
  }
  return actions.map((a, i) => ({ action: a, ...(expected[i] ? { expected: expected[i] as string } : {}) }));
}

function prefixRefs(r: ParseResult, prefix: string): ParseResult {
  return { ...r, cases: r.cases.map((c) => ({ ...c, externalRef: c.externalRef.replace(/^csv:/, `${prefix}:`) })) };
}
