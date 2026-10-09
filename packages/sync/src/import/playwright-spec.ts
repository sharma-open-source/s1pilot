import type { Assertion, LocatorCandidate } from '@s1pilot/domain';
import { Node, Project, SyntaxKind, type CallExpression, type Expression } from 'ts-morph';

import {
  importError,
  type ImportedAction,
  type ImportedCase,
  type ImportedStep,
  type ImportIssue,
  type ParseResult,
} from './types.js';

export interface PlaywrightSpecOptions {
  /** File name used in external refs and as the suite name. */
  source?: string;
}

const SECRETISH = /pass(word)?|secret|token|api[-_ ]?key|otp|pin|cvv/i;

/** A locator expression resolved to a candidate plus a readable label. */
interface Target {
  candidate: LocatorCandidate;
  label: string;
}

/**
 * Imports a Playwright spec (`.spec.ts`): every `test()` / `it()` body becomes a draft case (suites from
 * `describe` blocks, the file name as outer suite). Page actions (`goto`, `click`, `fill`, `check`,
 * `selectOption`, `press`, `hover`) become steps with generated step text and an `actions` list of locator
 * candidates for a learned script; `expect(...)` calls become assertions on the preceding step.
 * Fill values of secret-looking fields are never copied.
 */
export function parsePlaywrightSpec(text: string, opts: PlaywrightSpecOptions = {}): ParseResult {
  const source = opts.source ?? 'spec.ts';
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const file = project.createSourceFile('spec.ts', text, { overwrite: true });
  const cases: ImportedCase[] = [];
  const errors: ImportIssue[] = [];
  let n = 0;

  const visit = (call: CallExpression, path: string[]): void => {
    const kind = testCallKind(call);
    const title = stringArg(call.getArguments()[0]);
    const body = call.getArguments().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
    if (!kind || title === undefined || !body) return;
    if (kind === 'describe') {
      const inner = (body as import('ts-morph').ArrowFunction).getBody();
      for (const c of inner.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (c.getFirstAncestor((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a)) === body) {
          const k = testCallKind(c);
          if (k) visit(c, [...path, title]);
        }
      }
      return;
    }
    n++;
    const built = buildCase(body);
    if (built.steps.length === 0) {
      errors.push({ index: n, title, message: 'Test has no recognised page actions' });
      return;
    }
    cases.push({
      externalRef: `playwright:${source}:${[...path, title].join(' > ')}`,
      title,
      suitePath: [source.replace(/\.(spec|test)\.[cm]?[jt]sx?$/, ''), ...path],
      priority: 'P2',
      tags: [],
      steps: built.steps,
      parameters: [],
      actions: built.actions,
    });
  };

  // Only top-level calls (not nested in a describe body) are visited here; describe recurses itself.
  for (const stmt of file.getStatements()) {
    const call = stmt.getFirstDescendantByKind(SyntaxKind.CallExpression);
    if (call && Node.isExpressionStatement(stmt)) visit(call, []);
  }
  if (cases.length === 0 && errors.length === 0) importError('No test() blocks found in the spec');
  return { cases, errors };
}

function testCallKind(call: CallExpression): 'test' | 'describe' | undefined {
  const callee = call.getExpression().getText();
  if (/^(test|it)(\.(only|skip|fixme))?$/.test(callee)) return 'test';
  if (/^(test|it)\.describe(\.(serial|parallel|only|skip))?$|^describe(\.(only|skip))?$/.test(callee)) return 'describe';
  return undefined;
}

function stringArg(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  return undefined;
}

function buildCase(body: Node): { steps: ImportedStep[]; actions: ImportedAction[] } {
  const steps: ImportedStep[] = [];
  const actions: ImportedAction[] = [];
  const awaits = body.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => {
    // Only outermost calls of a chain (parent is not a property access on this call).
    const parent = c.getParent();
    return !(Node.isPropertyAccessExpression(parent) && parent.getExpression() === c);
  });

  for (const call of awaits) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      continue;
    }
    const method = callee.getName();
    const recv = callee.getExpression();
    const args = call.getArguments();

    if (method === 'goto' && recv.getText() === 'page') {
      const url = stringArg(args[0]);
      if (url === undefined) continue;
      steps.push({ action: `Open ${url}` });
      actions.push({ stepIndex: steps.length - 1, action: 'goto', locators: [], url });
      continue;
    }

    const target = targetOf(recv);
    if (target && ['click', 'dblclick', 'fill', 'check', 'uncheck', 'selectOption', 'press', 'hover', 'setChecked'].includes(method)) {
      const arg = stringArg(args[0]);
      const secret = SECRETISH.test(target.label);
      let action: ImportedAction['action'];
      let text: string;
      switch (method) {
        case 'fill':
          action = 'fill';
          text = secret || arg === undefined ? `Enter {${slug(target.candidate.name ?? target.candidate.value)}} in ${target.label}` : `Enter "${arg}" in ${target.label}`;
          break;
        case 'check':
        case 'setChecked':
          action = 'check';
          text = `Check ${target.label}`;
          break;
        case 'uncheck':
          action = 'uncheck';
          text = `Uncheck ${target.label}`;
          break;
        case 'selectOption':
          action = 'selectOption';
          text = `Select ${arg !== undefined ? `"${arg}"` : 'an option'} in ${target.label}`;
          break;
        case 'press':
          action = 'press';
          text = `Press ${arg ?? 'a key'} on ${target.label}`;
          break;
        case 'hover':
          action = 'hover';
          text = `Hover over ${target.label}`;
          break;
        default:
          action = 'click';
          text = `Click ${target.label}`;
      }
      steps.push({ action: text });
      actions.push({
        stepIndex: steps.length - 1,
        action,
        locators: [target.candidate],
        ...(arg !== undefined && !secret && action !== 'click' ? { value: arg } : {}),
      });
      continue;
    }

    if (isExpect(recv) || method.startsWith('to') || (Node.isPropertyAccessExpression(recv) && recv.getName() === 'not')) {
      const assertion = assertionOf(call);
      if (!assertion) continue;
      if (steps.length === 0) steps.push({ action: 'Verify the page' });
      const last = steps[steps.length - 1] as ImportedStep;
      last.expected = last.expected ? `${last.expected}; ${assertion.text}` : assertion.text;
      if (assertion.assert) last.assert = [...(last.assert ?? []), assertion.assert];
    }
  }
  return { steps, actions };
}

function isExpect(n: Expression): boolean {
  return Node.isCallExpression(n) && /^expect(\.soft|\.poll)?$/.test(n.getExpression().getText());
}

function assertionOf(call: CallExpression): { text: string; assert?: Assertion } | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const matcher = callee.getName();
  let recv: Expression = callee.getExpression();
  let negated = false;
  if (Node.isPropertyAccessExpression(recv) && recv.getName() === 'not') {
    negated = true;
    recv = recv.getExpression();
  }
  if (!Node.isCallExpression(recv) || !isExpect(recv)) return undefined;
  const subject = recv.getArguments()[0];
  const arg = call.getArguments()[0];
  const lit = stringArg(arg);
  const pattern = arg ? (Node.isRegularExpressionLiteral(arg) ? arg.getText() : lit) : undefined;
  if (!subject) return undefined;
  if (subject.getText() === 'page') {
    if (matcher === 'toHaveURL' && pattern !== undefined) {
      return { text: `The URL matches ${pattern}`, ...(negated ? {} : { assert: { type: 'urlMatches', pattern: regexSource(pattern) } as Assertion }) };
    }
    if (matcher === 'toHaveTitle' && lit !== undefined) {
      return { text: `The page title contains "${lit}"`, ...(negated ? {} : { assert: { type: 'titleContains', contains: lit } as Assertion }) };
    }
    return undefined;
  }
  const target = targetOf(subject as Expression);
  if (!target) return undefined;
  const c = target.candidate;
  const targetShape = {
    ...(c.kind === 'role' ? { role: c.value, ...(c.name ? { name: c.name } : {}) } : {}),
    ...(c.kind === 'text' ? { text: c.value } : {}),
    ...(c.kind === 'testId' ? { testId: c.value } : {}),
    ...(c.kind === 'css' ? { css: c.value } : {}),
  };
  if (matcher === 'toBeVisible' || matcher === 'toBeHidden') {
    const visible = (matcher === 'toBeVisible') !== negated;
    return {
      text: `${cap(target.label)} is ${visible ? 'visible' : 'not visible'}`,
      assert: { type: 'elementVisible', ...targetShape, visible } as Assertion,
    };
  }
  if ((matcher === 'toHaveText' || matcher === 'toContainText') && lit !== undefined) {
    return {
      text: `${cap(target.label)} ${negated ? 'does not contain' : 'contains'} "${lit}"`,
      ...(negated ? {} : { assert: { type: 'elementText', ...targetShape, contains: lit } as Assertion }),
    };
  }
  if (matcher === 'toHaveValue' && lit !== undefined && !negated) {
    return { text: `${cap(target.label)} has value "${lit}"`, assert: { type: 'elementValue', ...targetShape, equals: lit } as Assertion };
  }
  if (matcher === 'toHaveCount' && arg && Node.isNumericLiteral(arg) && !negated) {
    return {
      text: `${cap(target.label)} appears ${arg.getLiteralValue()} times`,
      assert: { type: 'elementCount', ...targetShape, equals: arg.getLiteralValue() } as Assertion,
    };
  }
  return undefined;
}

/** `/regex/` source or a plain string pattern. */
function regexSource(p: string): string {
  const m = /^\/(.*)\/[a-z]*$/.exec(p);
  return m ? (m[1] as string) : p;
}

/** Resolves `page.getByRole('button', { name: 'Save' })`, `.getByLabel()`, `.getByTestId()`, `.locator()`… */
function targetOf(expr: Node): Target | undefined {
  let node: Node = expr;
  while (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return undefined;
    const name = callee.getName();
    const args = node.getArguments();
    const a0 = stringArg(args[0]);
    if (name === 'getByRole' && a0 !== undefined) {
      const opts = args[1];
      let accessible: string | undefined;
      if (opts && Node.isObjectLiteralExpression(opts)) {
        const prop = opts.getProperty('name');
        if (prop && Node.isPropertyAssignment(prop)) accessible = stringArg(prop.getInitializer());
      }
      return {
        candidate: { kind: 'role', value: a0, ...(accessible ? { name: accessible } : {}) },
        label: accessible ? `the "${accessible}" ${a0}` : `the ${a0}`,
      };
    }
    if ((name === 'getByLabel' || name === 'getByPlaceholder' || name === 'getByText' || name === 'getByAltText' || name === 'getByTitle') && a0 !== undefined) {
      const kind = name === 'getByLabel' || name === 'getByPlaceholder' ? 'the "' + a0 + '" field' : `"${a0}"`;
      return { candidate: { kind: 'text', value: a0 }, label: kind };
    }
    if (name === 'getByTestId' && a0 !== undefined) return { candidate: { kind: 'testId', value: a0 }, label: `the "${a0}" element` };
    if (name === 'locator' && a0 !== undefined) return { candidate: { kind: 'css', value: a0 }, label: `the element "${a0}"` };
    if (name === 'first' || name === 'last' || name === 'nth' || name === 'filter') {
      node = callee.getExpression();
      continue;
    }
    return undefined;
  }
  return undefined;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s: string): string => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'value';
