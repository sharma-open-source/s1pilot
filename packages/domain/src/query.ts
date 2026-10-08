import { S1PilotError } from './errors.js';
import { PrioritySchema, TestCaseStatusSchema, type Priority, type TestCase, type TestCaseStatus } from './test-case.js';

/** Comparison operator of a `priority` clause. */
export type PriorityOp = '<=' | '>=' | '<' | '>' | '=';

/** One AND-ed term of a case query. */
export type QueryClause =
  | { kind: 'tag'; value: string }
  | { kind: 'priority'; op: PriorityOp; value: Priority }
  | { kind: 'status'; value: TestCaseStatus }
  | { kind: 'owner'; value: string }
  | { kind: 'text'; value: string };

/** Parsed case query: every clause must match. */
export interface CaseQuery {
  clauses: QueryClause[];
}

/** Splits on whitespace; double quotes group words (`owner:"Ann Lee"`). */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quoted) throw new S1PilotError('INVALID_QUERY', 'Unterminated quote in query', { query: input });
  if (has) out.push(cur);
  return out;
}

const PRIORITY_RE = /^priority(<=|>=|<|>|=|:)(.*)$/i;

/**
 * Parses the case query language subset (full grammar: S-049, which reuses this module).
 *
 * Terms are separated by whitespace or the keyword `AND` and are all required:
 * `tags:<tag>`, `priority<=P1` (operators `<= >= < > = :`), `status:<status>`, `owner:<name>`;
 * any other word is free text matched against title and key.
 * @throws S1PilotError `INVALID_QUERY` for unknown values, `OR`, or unterminated quotes.
 */
export function parseCaseQuery(input: string): CaseQuery {
  const clauses: QueryClause[] = [];
  for (const token of tokenize(input)) {
    if (token === 'AND') continue;
    if (token === 'OR') {
      throw new S1PilotError('INVALID_QUERY', 'OR is not supported yet', { query: input });
    }
    const prio = PRIORITY_RE.exec(token);
    if (prio) {
      const value = PrioritySchema.safeParse((prio[2] ?? '').toUpperCase());
      if (!value.success) {
        throw new S1PilotError('INVALID_QUERY', `Unknown priority "${prio[2] ?? ''}" (use P0-P3)`, { query: input });
      }
      const op = (prio[1] === ':' ? '=' : prio[1]) as PriorityOp;
      clauses.push({ kind: 'priority', op, value: value.data });
      continue;
    }
    const colon = token.indexOf(':');
    const field = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    const rest = colon > 0 ? token.slice(colon + 1) : '';
    if (field === 'tags' || field === 'tag') {
      if (!rest) throw new S1PilotError('INVALID_QUERY', 'tags: needs a value', { query: input });
      clauses.push({ kind: 'tag', value: rest });
    } else if (field === 'status') {
      const value = TestCaseStatusSchema.safeParse(rest.toLowerCase());
      if (!value.success) throw new S1PilotError('INVALID_QUERY', `Unknown status "${rest}"`, { query: input });
      clauses.push({ kind: 'status', value: value.data });
    } else if (field === 'owner') {
      if (!rest) throw new S1PilotError('INVALID_QUERY', 'owner: needs a value', { query: input });
      clauses.push({ kind: 'owner', value: rest });
    } else {
      clauses.push({ kind: 'text', value: token });
    }
  }
  return { clauses };
}

const rank = (p: Priority): number => Number(p.slice(1));

/** True when the case satisfies every clause. Tag, owner and text comparisons are case-insensitive. */
export function matchesCaseQuery(
  c: Pick<TestCase, 'key' | 'title' | 'tags' | 'priority' | 'status' | 'owner'>,
  query: CaseQuery,
): boolean {
  return query.clauses.every((cl) => {
    switch (cl.kind) {
      case 'tag':
        return c.tags.some((t) => t.toLowerCase() === cl.value.toLowerCase());
      case 'status':
        return c.status === cl.value;
      case 'owner':
        return (c.owner ?? '').toLowerCase() === cl.value.toLowerCase();
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
  });
}
