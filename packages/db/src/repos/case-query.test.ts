import { matchesQuery, newId, parseQuery, type Priority, type QueryNode, type QueryRow, type TestCase } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { caseInput, makeProject, memoryDb } from '../test-utils.js';

import { buildQuerySqlContext, listCasesByQuery } from './case-query.js';

import { repos } from './index.js';

/** Small deterministic PRNG (mulberry32) so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ['smoke', 'checkout', 'cart', 'Auth'];
const OWNERS = ['ann', 'bob'];
const REQS = ['REQ-1', 'REQ-2'];
const VERDICTS = ['passed', 'failed', 'flaky', 'blocked'] as const;

async function seed(rand: () => number) {
  const db = memoryDb();
  const project = await makeProject(db);
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'dev', baseUrl: 'http://localhost:3000' });
  const root = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'Checkout' });
  const child = await repos.suites.create(db, { id: newId(), projectId: project.id, parentId: root.id, name: 'Payment' });
  const other = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'Search' });
  const suiteOf = [root, child, other, undefined];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const run1 = await repos.runs.create(db, { id: newId(), projectId: project.id, trigger: 'manual', status: 'passed', startedAt: '2026-01-01T00:00:00.000Z' });
  const run2 = await repos.runs.create(db, { id: newId(), projectId: project.id, trigger: 'manual', status: 'passed', startedAt: '2026-01-02T00:00:00.000Z' });
  const created: TestCase[] = [];
  const extra = new Map<string, Pick<QueryRow, 'learned' | 'lastResult' | 'quarantined'>>();
  const quarantinedIds: string[] = [];
  for (let i = 0; i < 40; i++) {
    const suite = pick(suiteOf);
    const c = await repos.cases.create(db, project.id, {
      ...caseInput(`Case ${i} ${pick(['login', 'pay', 'search'])}`),
      priority: pick(['P0', 'P1', 'P2', 'P3'] as Priority[]),
      status: pick(['draft', 'ready', 'deprecated'] as const),
      type: pick(['smoke', 'regression', 'e2e', 'exploratory'] as const),
      tags: TAGS.filter(() => rand() < 0.35),
      requirements: REQS.filter(() => rand() < 0.3),
      ...(rand() < 0.7 ? { owner: pick(OWNERS) } : {}),
      ...(suite ? { suiteId: suite.id } : {}),
    });
    created.push(c);
    const learned = rand() < 0.4;
    if (learned) {
      await repos.learnedScripts.upsert(db, { id: newId(), caseId: c.id, caseVersion: 1, environmentId: env.id, createdFromRunId: run1.id, actions: [] });
    }
    let lastResult: string | undefined;
    if (rand() < 0.7) {
      await repos.results.createCase(db, { id: newId(), runId: run1.id, caseId: c.id, caseVersion: 1, verdict: pick(VERDICTS), durationMs: 1, mode: 'explore' });
      lastResult = pick(VERDICTS);
      await repos.results.createCase(db, { id: newId(), runId: run2.id, caseId: c.id, caseVersion: 1, verdict: lastResult as (typeof VERDICTS)[number], durationMs: 1, mode: 'explore' });
    }
    const quarantined = rand() < 0.15;
    if (quarantined) quarantinedIds.push(c.id);
    extra.set(c.id, { learned, lastResult, quarantined });
  }
  const suiteNames = (id: string | undefined): string[] =>
    id === root.id ? ['Checkout'] : id === child.id ? ['Payment', 'Checkout'] : id === other.id ? ['Search'] : [];
  const rows = created.map((c): QueryRow & { id: string } => ({ ...c, ...extra.get(c.id), suites: suiteNames(c.suiteId) }));
  return { db, project, rows, quarantinedIds };
}

function randomTerm(rand: () => number): string {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  switch (Math.floor(rand() * 11)) {
    case 0: return `tags:${pick(['smoke', 'CHECKOUT', 'cart', 'auth', 'nope'])}`;
    case 1: return `priority${pick(['<=', '>=', '<', '>', '=', ':'])}${pick(['P0', 'P1', 'P2', 'P3'])}`;
    case 2: return `status:${pick(['draft', 'ready', 'deprecated'])}`;
    case 3: return `owner:${pick(['ann', 'BOB', 'zed'])}`;
    case 4: return `type:${pick(['smoke', 'regression', 'e2e', 'exploratory'])}`;
    case 5: return `suite:${pick(['Checkout', 'payment', 'Search', 'Missing'])}`;
    case 6: return `requirement:${pick(REQS)}`;
    case 7: return `learned:${pick(['yes', 'no'])}`;
    case 8: return `lastResult:${pick(['passed', 'failed', 'flaky', 'blocked', 'none'])}`;
    case 9: return `quarantined:${pick(['yes', 'no'])}`;
    default: return pick(['login', 'PAY', 'tc-7', '"case 1"']);
  }
}

function randomQuery(rand: () => number, depth = 0): string {
  const r = rand();
  if (depth >= 3 || r < 0.35) return randomTerm(rand);
  if (r < 0.5) return `NOT ${depth < 3 && rand() < 0.5 ? `(${randomQuery(rand, depth + 1)})` : randomTerm(rand)}`;
  if (r < 0.6) return `(${randomQuery(rand, depth + 1)})`;
  const op = r < 0.8 ? ' AND ' : r < 0.95 ? ' OR ' : ' ';
  return `${randomQuery(rand, depth + 1)}${op}${randomQuery(rand, depth + 1)}`;
}

describe('case query SQL vs in-memory matcher', () => {
  it('returns the expected cases for the spec example', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const checkout = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'Checkout' });
    const mk = (title: string, over: Record<string, unknown>) =>
      repos.cases.create(db, project.id, { ...caseInput(title), ...over });
    const a = await mk('a', { suiteId: checkout.id, priority: 'P1', status: 'ready' });
    await mk('b', { suiteId: checkout.id, priority: 'P3', status: 'ready' });
    await mk('c', { suiteId: checkout.id, priority: 'P0', status: 'draft' });
    await mk('d', { priority: 'P0', status: 'ready' });
    const e = await mk('e', { suiteId: checkout.id, priority: 'P2', status: 'ready' });
    const got = await listCasesByQuery(db, project.id, parseQuery('suite:Checkout AND priority<=P2 AND status:ready'));
    expect(got.map((c) => c.id)).toEqual([a.id, e.id]);
  });

  it('agrees on randomly generated queries (property)', async () => {
    const rand = prng(20261009);
    const { db, project, rows, quarantinedIds } = await seed(rand);
    const ctx = await buildQuerySqlContext(db, project.id, quarantinedIds);
    expect(ctx.suiteIds('checkout')).toHaveLength(2);
    let nonTrivial = 0;
    for (let i = 0; i < 300; i++) {
      const text = randomQuery(rand);
      const node: QueryNode = parseQuery(text);
      const expected = rows.filter((r) => matchesQuery({ ...r, quarantined: quarantinedIds.includes(r.id) }, node)).map((r) => r.id);
      const actual = (await listCasesByQuery(db, project.id, node, quarantinedIds)).map((c) => c.id);
      expect(actual, text).toEqual(expected);
      if (expected.length > 0 && expected.length < rows.length) nonTrivial++;
    }
    expect(nonTrivial).toBeGreaterThan(100);
  });
});
