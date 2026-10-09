import { repos, type Db } from '@s1pilot/db';
import { newId, type Suite, type TestCase } from '@s1pilot/domain';

import type { ImportedCase, ImportIssue } from './types.js';

export interface ApplyImportOptions {
  /** Suite the imported suite paths are created under; none puts them at the top level. */
  targetSuiteId?: string;
}

export interface ImportReport {
  created: number;
  updated: number;
  /** Cases already identical to the source (re-import with no changes). */
  skipped: number;
  errors: ImportIssue[];
  /** Keys of the cases touched, in source order. */
  keys: string[];
}

/**
 * Writes imported cases into a project. Cases are matched by `externalRef`: a match is updated (new
 * version only when the content changed), otherwise a draft case is created. Suite paths are created on
 * demand under `targetSuiteId`.
 */
export async function applyImport(
  db: Db,
  projectId: string,
  cases: ImportedCase[],
  opts: ApplyImportOptions = {},
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: [], keys: [] };
  const suites: Suite[] = await repos.suites.listByProject(db, projectId);
  const suiteFor = async (path: string[]): Promise<string | undefined> => {
    let parent = opts.targetSuiteId;
    for (const name of path) {
      let found = suites.find((s) => s.name === name && s.parentId === parent);
      if (!found) {
        found = await repos.suites.create(db, {
          id: newId(),
          projectId,
          name,
          position: suites.filter((s) => s.parentId === parent).length,
          ...(parent !== undefined ? { parentId: parent } : {}),
        });
        suites.push(found);
      }
      parent = found.id;
    }
    return parent;
  };

  for (const [i, c] of cases.entries()) {
    try {
      const suiteId = await suiteFor(c.suitePath);
      const content = {
        title: c.title,
        priority: c.priority,
        ...(c.type ? { type: c.type } : {}),
        tags: c.tags,
        steps: c.steps.map((s) => ({
          action: s.action,
          ...(s.expected ? { expected: s.expected } : {}),
          assert: s.assert ?? [],
          inputs: [] as string[],
        })),
        parameters: c.parameters,
        ...(suiteId !== undefined ? { suiteId } : {}),
        externalRef: c.externalRef,
      };
      const existing = await repos.cases.getByExternalRef(db, projectId, c.externalRef);
      if (!existing) {
        const created = await repos.cases.create(db, projectId, { ...content, status: 'draft' });
        report.created++;
        report.keys.push(created.key);
      } else if (sameContent(existing, content)) {
        report.skipped++;
        report.keys.push(existing.key);
      } else {
        const updated = await repos.cases.update(db, existing.id, content);
        report.updated++;
        report.keys.push(updated.key);
      }
    } catch (e) {
      report.errors.push({ index: i + 1, title: c.title, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

function sameContent(existing: TestCase, next: { title: string; priority: string; tags: string[]; steps: unknown[]; parameters: unknown[]; suiteId?: string }): boolean {
  const norm = (s: unknown[]): string => JSON.stringify(
      s.map((x) => {
        const { action, expected, assert } = x as { action: string; expected?: string; assert?: unknown[] };
        return [action, expected ?? '', assert ?? []];
      }),
    );
  return (
    existing.title === next.title &&
    existing.priority === next.priority &&
    existing.suiteId === next.suiteId &&
    JSON.stringify(existing.tags) === JSON.stringify(next.tags) &&
    JSON.stringify(existing.parameters) === JSON.stringify(next.parameters) &&
    norm(existing.steps) === norm(next.steps)
  );
}
