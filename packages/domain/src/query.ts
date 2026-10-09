import { S1PilotError } from './errors.js';
import { VerdictSchema, type Verdict } from './run.js';
import {
  PrioritySchema,
  TestCaseStatusSchema,
  TestCaseTypeSchema,
  type Priority,
  type TestCase,
  type TestCaseStatus,
  type TestCaseType,
} from './test-case.js';

/** Comparison operator of a `priority` clause. */
export type PriorityOp = '<=' | '>=' | '<' | '>' | '=';

/** `lastResult` values: a case verdict, or `none` for a case that never ran. */
export type LastResultValue = Verdict | 'none';

/** One leaf term of a case query. */
export type QueryClause =
  | { kind: 'tag'; value: string }
  | { kind: 'priority'; op: PriorityOp; value: Priority }
  | { kind: 'status'; value: TestCaseStatus }
  | { kind: 'owner'; value: string }
  | { kind: 'type'; value: TestCaseType }
  | { kind: 'suite'; value: string }
  | { kind: 'requirement'; value: string }
  | { kind: 'learned'; value: boolean }
  | { kind: 'lastResult'; value: LastResultValue }
  | { kind: 'quarantined'; value: boolean }
  | { kind: 'text'; value: string };

/** Query AST. `all` is the empty query. */
export type QueryTree<C> =
  | { type: 'all' }
  | { type: 'clause'; clause: C }
  | { type: 'not'; node: QueryTree<C> }
  | { type: 'and'; left: QueryTree<C>; right: QueryTree<C> }
  | { type: 'or'; left: QueryTree<C>; right: QueryTree<C> };

/** Case query AST. */
export type QueryNode = QueryTree<QueryClause>;

/** Parsed case query (the AST root). */
export type CaseQuery = QueryNode;

/** Fields a case needs to be matched in memory. Optional context fields default to "no" / empty. */
export interface QueryRow {
  key: string;
  title: string;
  tags: string[];
  priority: Priority;
  status: TestCaseStatus;
  type?: TestCaseType | undefined;
  owner?: string | undefined;
  /** Requirement keys linked to the case. */
  requirements?: string[] | undefined;
  /** Names of the case's suite and its ancestors (any order). */
  suites?: string[] | undefined;
  /** True when a learned script exists. */
  learned?: boolean | undefined;
  /** Verdict of the latest result; absent = never ran. */
  lastResult?: string | undefined;
  quarantined?: boolean | undefined;
}

interface Token {
  kind: 'lparen' | 'rparen' | 'word';
  text: string;
  /** 0-based index in the input. */
  pos: number;
  /** True when part of the word was quoted (then it is never a keyword). */
  quoted: boolean;
}

function fail(input: string, message: string, position: number): never {
  throw new S1PilotError('INVALID_QUERY', `${message} at position ${position}`, { query: input, position });
}

/** Splits into words and parentheses; double quotes group characters (`owner:"Ann Lee"`). */
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '(' || ch === ')') {
      out.push({ kind: ch === '(' ? 'lparen' : 'rparen', text: ch, pos: i, quoted: false });
      i++;
    } else {
      const start = i;
      let text = '';
      let quoted = false;
      let open = -1;
      for (; i < input.length; i++) {
        const c = input[i] as string;
        if (c === '"') {
          quoted = true;
          open = open < 0 ? i : -1;
        } else if (open < 0 && (/\s/.test(c) || c === '(' || c === ')')) {
          break;
        } else {
          text += c;
        }
      }
      if (open >= 0) fail(input, 'Unterminated quote', open);
      out.push({ kind: 'word', text, pos: start, quoted });
    }
  }
  return out;
}

const PRIORITY_RE = /^priority(<=|>=|<|>|=|:)(.*)$/i;

function yesNo(input: string, field: string, raw: string, pos: number): boolean {
  const v = raw.toLowerCase();
  if (v === 'yes' || v === 'true') return true;
  if (v === 'no' || v === 'false') return false;
  return fail(input, `${field}: expects yes or no, got "${raw}"`, pos);
}

function parseTerm(input: string, tok: Token): QueryClause {
  const prio = PRIORITY_RE.exec(tok.text);
  if (prio) {
    const value = PrioritySchema.safeParse((prio[2] ?? '').toUpperCase());
    if (!value.success) return fail(input, `Unknown priority "${prio[2] ?? ''}" (use P0-P3)`, tok.pos);
    return { kind: 'priority', op: (prio[1] === ':' ? '=' : prio[1]) as PriorityOp, value: value.data };
  }
  const colon = tok.text.indexOf(':');
  const field = colon > 0 ? tok.text.slice(0, colon).toLowerCase() : '';
  const rest = colon > 0 ? tok.text.slice(colon + 1) : '';
  const needValue = (): void => {
    if (!rest) fail(input, `${field}: needs a value`, tok.pos);
  };
  switch (field) {
    case 'tags':
    case 'tag':
      needValue();
      return { kind: 'tag', value: rest };
    case 'suite':
      needValue();
      return { kind: 'suite', value: rest };
    case 'owner':
      needValue();
      return { kind: 'owner', value: rest };
    case 'requirement':
    case 'requirements':
      needValue();
      return { kind: 'requirement', value: rest };
    case 'status': {
      const value = TestCaseStatusSchema.safeParse(rest.toLowerCase());
      if (!value.success) return fail(input, `Unknown status "${rest}" (use draft, ready or deprecated)`, tok.pos);
      return { kind: 'status', value: value.data };
    }
    case 'type': {
      const value = TestCaseTypeSchema.safeParse(rest.toLowerCase());
      if (!value.success) return fail(input, `Unknown type "${rest}" (use smoke, regression, e2e or exploratory)`, tok.pos);
      return { kind: 'type', value: value.data };
    }
    case 'learned':
      return { kind: 'learned', value: yesNo(input, field, rest, tok.pos) };
    case 'quarantined':
      return { kind: 'quarantined', value: yesNo(input, field, rest, tok.pos) };
    case 'lastresult': {
      const v = rest.toLowerCase();
      if (v === 'none') return { kind: 'lastResult', value: 'none' };
      const value = VerdictSchema.safeParse(v);
      if (!value.success) return fail(input, `Unknown lastResult "${rest}"`, tok.pos);
      return { kind: 'lastResult', value: value.data };
    }
    default:
      return { kind: 'text', value: tok.text };
  }
}

const isKeyword = (t: Token | undefined, kw: string): boolean => t?.kind === 'word' && !t.quoted && t.text === kw;

/**
 * Parses the case query language into an AST.
 *
 * Terms: `suite:`, `tags:`, `priority<=P1` (operators `<= >= < > = :`), `status:`, `owner:`, `type:`,
 * `requirement:`, `learned:yes|no`, `lastResult:<verdict|none>`, `quarantined:yes|no`; any other word is free
 * text matched against title and key. Combine with `AND` / `OR` / `NOT` (uppercase) and parentheses; adjacent
 * terms are AND-ed. Precedence: `NOT` > `AND` > `OR`. Double quotes group values (`owner:"Ann Lee"`).
 * @throws S1PilotError `INVALID_QUERY` with `details.position` (0-based) for syntax errors and unknown values.
 */
export function parseQuery(input: string): QueryNode {
  return parseWith(input, parseTerm);
}

/** Shared boolean grammar (AND / OR / NOT, parentheses, quotes); `term` turns one word into a clause. */
function parseWith<C>(input: string, term: (input: string, tok: Token) => C): QueryTree<C> {
  type QueryNode = QueryTree<C>;
  const tokens = tokenize(input);
  if (tokens.length === 0) return { type: 'all' };
  let i = 0;
  const peek = (): Token | undefined => tokens[i];

  const startsUnary = (t: Token | undefined): boolean =>
    t !== undefined && (t.kind === 'lparen' || (t.kind === 'word' && !(isKeyword(t, 'AND') || isKeyword(t, 'OR'))));

  const unary = (): QueryNode => {
    const t = peek();
    if (!t) return fail(input, 'Unexpected end of query', input.length);
    if (t.kind === 'rparen') return fail(input, 'Unexpected ")"', t.pos);
    if (t.kind === 'lparen') {
      i++;
      if (peek()?.kind === 'rparen') return fail(input, 'Empty parentheses', t.pos);
      const node = or();
      const close = peek();
      if (close?.kind !== 'rparen') return fail(input, 'Missing ")" for "("', t.pos);
      i++;
      return node;
    }
    if (isKeyword(t, 'NOT')) {
      i++;
      return { type: 'not', node: unary() };
    }
    if (isKeyword(t, 'AND') || isKeyword(t, 'OR')) return fail(input, `Unexpected ${t.text}`, t.pos);
    i++;
    return { type: 'clause', clause: term(input, t) };
  };

  const and = (): QueryNode => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (isKeyword(t, 'AND')) {
        i++;
        left = { type: 'and', left, right: unary() };
      } else if (startsUnary(t)) {
        left = { type: 'and', left, right: unary() };
      } else return left;
    }
  };

  function or(): QueryNode {
    let left = and();
    while (isKeyword(peek(), 'OR')) {
      i++;
      left = { type: 'or', left, right: and() };
    }
    return left;
  }

  const root = or();
  const rest = peek();
  if (rest) fail(input, rest.kind === 'rparen' ? 'Unmatched ")"' : `Unexpected "${rest.text}"`, rest.pos);
  return root;
}

/** Alias of {@link parseQuery} kept for the case list (S-033). */
export const parseCaseQuery = parseQuery;

const rank = (p: Priority): number => Number(p.slice(1));
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function matchesClause(c: QueryRow, cl: QueryClause): boolean {
  switch (cl.kind) {
    case 'tag':
      return c.tags.some((t) => eq(t, cl.value));
    case 'status':
      return c.status === cl.value;
    case 'type':
      return c.type === cl.value;
    case 'owner':
      return eq(c.owner ?? '', cl.value);
    case 'suite':
      return (c.suites ?? []).some((s) => eq(s, cl.value));
    case 'requirement':
      return (c.requirements ?? []).some((r) => eq(r, cl.value));
    case 'learned':
      return (c.learned ?? false) === cl.value;
    case 'quarantined':
      return (c.quarantined ?? false) === cl.value;
    case 'lastResult':
      return (c.lastResult ?? 'none') === cl.value;
    case 'text': {
      const needle = cl.value.toLowerCase();
      return c.title.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle);
    }
    case 'priority': {
      const a = rank(c.priority);
      const b = rank(cl.value);
      if (cl.op === '<=') return a <= b;
      if (cl.op === '>=') return a >= b;
      if (cl.op === '<') return a < b;
      if (cl.op === '>') return a > b;
      return a === b;
    }
  }
}

/** In-memory matcher for a parsed query. Tag, owner, suite, requirement and text comparisons are case-insensitive. */
export function matchesQuery(c: QueryRow, node: QueryNode): boolean {
  switch (node.type) {
    case 'all':
      return true;
    case 'clause':
      return matchesClause(c, node.clause);
    case 'not':
      return !matchesQuery(c, node.node);
    case 'and':
      return matchesQuery(c, node.left) && matchesQuery(c, node.right);
    case 'or':
      return matchesQuery(c, node.left) || matchesQuery(c, node.right);
  }
}

/** Matcher used by the case list (S-033): a case plus optional context fields. */
export function matchesCaseQuery(
  c: Pick<TestCase, 'key' | 'title' | 'tags' | 'priority' | 'status' | 'owner'> & Partial<QueryRow>,
  query: CaseQuery,
): boolean {
  return matchesQuery(c, query);
}

/** Defect statuses accepted by `status:` (S-054). */
const DEFECT_STATUSES = ['draft', 'open', 'in-progress', 'fixed', 'closed'] as const;
const DEFECT_SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;
/** `tracker:` values: a provider, or `none` / `local` for defects not pushed to a tracker. */
const DEFECT_TRACKERS = ['jira', 'github', 'linear', 'none', 'local'] as const;

/** One leaf term of a defect query. */
export type DefectQueryClause =
  | { kind: 'status'; value: (typeof DEFECT_STATUSES)[number] }
  | { kind: 'severity'; value: (typeof DEFECT_SEVERITIES)[number] }
  | { kind: 'tracker'; value: (typeof DEFECT_TRACKERS)[number] }
  | { kind: 'text'; value: string };

/** Defect query AST. */
export type DefectQueryNode = QueryTree<DefectQueryClause>;

/** Fields a defect needs to be matched in memory. */
export interface DefectQueryRow {
  /** Human key (`DEF-3`). */
  key: string;
  title: string;
  status: string;
  severity: string;
  /** External tracker provider, if the defect was pushed. */
  tracker?: string | undefined;
}

function parseDefectTerm(input: string, tok: Token): DefectQueryClause {
  const colon = tok.text.indexOf(':');
  const field = colon > 0 ? tok.text.slice(0, colon).toLowerCase() : '';
  const rest = colon > 0 ? tok.text.slice(colon + 1) : '';
  const oneOf = <T extends string>(values: readonly T[], map: (v: string) => string, label: string): T => {
    const v = values.find((x) => x.toLowerCase() === map(rest));
    return v ?? fail(input, `Unknown ${label} "${rest}" (use ${values.join(', ')})`, tok.pos);
  };
  switch (field) {
    case 'status':
      return { kind: 'status', value: oneOf(DEFECT_STATUSES, (v) => v.toLowerCase(), 'status') };
    case 'severity':
    case 'sev':
      return { kind: 'severity', value: oneOf(DEFECT_SEVERITIES, (v) => v.toLowerCase(), 'severity') };
    case 'tracker':
      return { kind: 'tracker', value: oneOf(DEFECT_TRACKERS, (v) => v.toLowerCase(), 'tracker') };
    default:
      return { kind: 'text', value: tok.text };
  }
}

/**
 * Parses the defect filter language with the same grammar as {@link parseQuery}: `status:`, `severity:` (S1-S4),
 * `tracker:` (jira, github, linear, none), free text against key and title.
 * @throws S1PilotError `INVALID_QUERY` with `details.position`.
 */
export function parseDefectQuery(input: string): DefectQueryNode {
  return parseWith(input, parseDefectTerm);
}

function matchesDefectClause(d: DefectQueryRow, cl: DefectQueryClause): boolean {
  switch (cl.kind) {
    case 'status':
      return d.status === cl.value;
    case 'severity':
      return d.severity === cl.value;
    case 'tracker':
      return cl.value === 'none' || cl.value === 'local' ? !d.tracker : d.tracker === cl.value;
    case 'text': {
      const needle = cl.value.toLowerCase();
      return d.title.toLowerCase().includes(needle) || d.key.toLowerCase().includes(needle);
    }
  }
}

/** In-memory matcher for a parsed defect query. */
export function matchesDefectQuery(d: DefectQueryRow, node: DefectQueryNode): boolean {
  switch (node.type) {
    case 'all':
      return true;
    case 'clause':
      return matchesDefectClause(d, node.clause);
    case 'not':
      return !matchesDefectQuery(d, node.node);
    case 'and':
      return matchesDefectQuery(d, node.left) && matchesDefectQuery(d, node.right);
    case 'or':
      return matchesDefectQuery(d, node.left) || matchesDefectQuery(d, node.right);
  }
}
