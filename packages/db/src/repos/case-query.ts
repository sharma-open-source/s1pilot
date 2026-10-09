import { TestCaseSchema, type QueryClause, type QueryNode, type TestCase } from '@s1pilot/domain';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db.js';
import { suites as suitesTable, testCases as t } from '../schema/index.js';

import { fromRow } from './util.js';

/** Context the SQL translation needs for terms that go beyond the case row. */
export interface QuerySqlContext {
  /** Ids of every suite named `name` (case-insensitive) and all their descendants. */
  suiteIds(name: string): string[];
  /** Ids of quarantined cases (`repos.cases.quarantinedIds`). */
  quarantinedIds: string[];
}

const inList = (column: SQL, ids: string[]): SQL =>
  ids.length === 0 ? sql`0` : sql`${column} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;

function clauseSql(cl: QueryClause, ctx: QuerySqlContext): SQL {
  switch (cl.kind) {
    case 'tag':
      return sql`exists (select 1 from json_each(${t.tags}) where lower(value) = lower(${cl.value}))`;
    case 'requirement':
      return sql`exists (select 1 from json_each(${t.requirements}) where lower(value) = lower(${cl.value}))`;
    case 'status':
      return sql`${t.status} = ${cl.value}`;
    case 'type':
      return sql`${t.type} = ${cl.value}`;
    case 'owner':
      return sql`lower(coalesce(${t.owner}, '')) = lower(${cl.value})`;
    case 'suite':
      return sql`coalesce(${inList(sql`${t.suiteId}`, ctx.suiteIds(cl.value))}, 0)`;
    case 'learned': {
      const has = sql`exists (select 1 from learned_scripts ls where ls.case_id = ${t.id})`;
      return cl.value ? has : sql`not ${has}`;
    }
    case 'quarantined': {
      const q = inList(sql`${t.id}`, ctx.quarantinedIds);
      return cl.value ? q : sql`not ${q}`;
    }
    case 'lastResult':
      return sql`coalesce((select cr.verdict from case_results cr join test_runs tr on tr.id = cr.run_id where cr.case_id = ${t.id} order by tr.started_at desc, cr.attempt desc limit 1), 'none') = ${cl.value}`;
    case 'text': {
      return sql`(instr(lower(${t.title}), lower(${cl.value})) > 0 or instr(lower(${t.key}), lower(${cl.value})) > 0)`;
    }
    case 'priority': {
      const rank = sql`cast(substr(${t.priority}, 2) as integer)`;
      const n = Number(cl.value.slice(1));
      const op = cl.op === '=' ? sql`=` : sql.raw(cl.op);
      return sql`${rank} ${op} ${n}`;
    }
  }
}

/** Translates a parsed query into a SQL predicate over `test_cases` (mirror of `matchesQuery`). */
export function queryToSql(node: QueryNode, ctx: QuerySqlContext): SQL {
  switch (node.type) {
    case 'all':
      return sql`1`;
    case 'clause':
      return sql`(${clauseSql(node.clause, ctx)})`;
    case 'not':
      return sql`(not ${queryToSql(node.node, ctx)})`;
    case 'and':
      return sql`(${queryToSql(node.left, ctx)} and ${queryToSql(node.right, ctx)})`;
    case 'or':
      return sql`(${queryToSql(node.left, ctx)} or ${queryToSql(node.right, ctx)})`;
  }
}

/** Builds a {@link QuerySqlContext} from a project's suites. */
export async function buildQuerySqlContext(db: Db, projectId: string, quarantinedIds: string[] = []): Promise<QuerySqlContext> {
  const all = db.orm.select().from(suitesTable).where(eq(suitesTable.projectId, projectId)).all();
  return {
    quarantinedIds,
    suiteIds(name) {
      const ids = new Set(all.filter((s) => s.name.toLowerCase() === name.toLowerCase()).map((s) => s.id));
      for (let grew = true; grew; ) {
        grew = false;
        for (const s of all) {
          if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
            ids.add(s.id);
            grew = true;
          }
        }
      }
      return [...ids];
    },
  };
}

/** Cases of a project matching a parsed query, ordered by case number. Decoded with the domain schema. */
export async function listCasesByQuery(
  db: Db,
  projectId: string,
  node: QueryNode,
  quarantinedIds: string[] = [],
): Promise<TestCase[]> {
  const ctx = await buildQuerySqlContext(db, projectId, quarantinedIds);
  return db.orm
    .select()
    .from(t)
    .where(and(eq(t.projectId, projectId), queryToSql(node, ctx)))
    .orderBy(t.number)
    .all()
    .map((row) => fromRow(TestCaseSchema, row));
}
