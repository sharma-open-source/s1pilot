import { join, resolve } from 'node:path';

import { openDb, repos, type Db } from '@s1pilot/db';
import { S1PilotError } from '@s1pilot/domain';
import { PROJECT_DIR, exportProject, importProject, syncDir, syncStatus, type SyncPlan } from '@s1pilot/sync';
import type { Command } from 'commander';

import type { CliDeps } from './program.js';

interface SyncOptions {
  dir: string;
  project?: string;
  db?: string;
  json?: boolean;
  dryRun?: boolean;
  prune?: boolean;
}

/** Formats a sync plan for the terminal. */
export function formatPlan(plan: SyncPlan, dryRun: boolean): string {
  const lines: string[] = [];
  const section = (label: string, items: { kind: string; id: string; file: string }[]): void => {
    for (const i of items) lines.push(`${label} ${i.kind} ${i.id}  (${i.file})`);
  };
  section(dryRun ? 'would create' : 'created', plan.creates);
  section(dryRun ? 'would update' : 'updated', plan.updates);
  section('not deleted (use --prune)', plan.deletes);
  for (const c of plan.conflicts) {
    lines.push(`CONFLICT case ${c.id}: file is based on v${c.fileVersion}, database is at v${c.dbVersion} (${c.file})`, c.diff.trimEnd());
  }
  if (lines.length === 0) lines.push('Already in sync.');
  return `${lines.join('\n')}\n`;
}

async function withDb<T>(opts: SyncOptions, fn: (db: Db) => Promise<T>): Promise<T> {
  const dbPath = opts.db ?? join(syncDir(opts.dir), 'data.db');
  const db = openDb({ url: dbPath });
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function resolveProjectId(db: Db, opts: SyncOptions): Promise<string> {
  const all = await repos.projects.list(db);
  const found = opts.project ? all.find((p) => p.key === opts.project) : all.length === 1 ? all[0] : undefined;
  if (!found) {
    const hint = opts.project ? `no project with key ${opts.project}` : `${all.length} projects found; pass --project <key>`;
    throw new S1PilotError('PROJECT_NOT_FOUND', `Cannot pick a project: ${hint}`);
  }
  return found.id;
}

/** Registers `s1pilot sync export|import|status`. */
export function registerSyncCommands(program: Command, deps: CliDeps): void {
  const sync = program.command('sync').description(`Two-way sync between the database and the git-friendly ${PROJECT_DIR}/ folder`);
  const common = (cmd: Command): Command =>
    cmd
      .option('--dir <dir>', `project directory containing ${PROJECT_DIR}/`, '.')
      .option('--project <key>', 'project key (default: the only project in the database)')
      .option('--db <file>', `database file (default: <dir>/${PROJECT_DIR}/data.db)`)
      .option('--json', 'print the result as JSON');

  const run = (action: (opts: SyncOptions) => Promise<number>) => async (opts: SyncOptions) => {
    try {
      deps.setExitCode(await action({ ...opts, dir: resolve(opts.dir) }));
    } catch (error) {
      if (!(error instanceof S1PilotError)) throw error;
      deps.stderr(`${error.message}\n`);
      deps.setExitCode(3);
    }
  };

  common(sync.command('export').description('Write the project to the folder (deterministic YAML, no secret values)')).action(
    run((opts) =>
      withDb(opts, async (db) => {
        const res = await exportProject(db, await resolveProjectId(db, opts), opts.dir);
        deps.stdout(
          opts.json
            ? `${JSON.stringify(res, null, 2)}\n`
            : `Exported to ${res.dir}: ${res.written.length} written, ${res.removed.length} removed.\n`,
        );
        return 0;
      }),
    ),
  );

  common(sync.command('import').description('Apply the folder to the database; version conflicts are reported, never overwritten'))
    .option('--dry-run', 'show what would change without writing')
    .option('--prune', 'also delete database entities that have no file')
    .action(
      run((opts) =>
        withDb(opts, async (db) => {
          const plan = await importProject(db, opts.dir, { dryRun: opts.dryRun === true, prune: opts.prune === true });
          deps.stdout(opts.json ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan, opts.dryRun === true));
          return plan.conflicts.length > 0 ? 1 : 0;
        }),
      ),
    );

  common(sync.command('status').description('Compare the database with the folder (exit 1 unless clean)')).action(
    run((opts) =>
      withDb(opts, async (db) => {
        const status = await syncStatus(db, await resolveProjectId(db, opts), opts.dir);
        if (opts.json) deps.stdout(`${JSON.stringify(status, null, 2)}\n`);
        else if (status === 'clean') deps.stdout(`Synced with ${PROJECT_DIR}/ in git · clean\n`);
        else {
          deps.stdout(`${status.changedFiles.length} changed file(s), ${status.conflicts.length} conflict(s)\n`);
          for (const f of status.changedFiles) deps.stdout(`  ${f}\n`);
          for (const c of status.conflicts) deps.stdout(`  CONFLICT ${c.id}: file v${c.fileVersion}, database v${c.dbVersion}\n`);
        }
        return status === 'clean' ? 0 : 1;
      }),
    ),
  );
}
