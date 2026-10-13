import { copySqliteToPg, isPostgresUrl, openDb, openPgDb } from '@s1pilot/db';
import { S1PilotError } from '@s1pilot/domain';
import type { Command } from 'commander';

import type { CliDeps } from './program.js';

interface MigrateOptions {
  from: string;
  to?: string;
  json?: boolean;
}

/**
 * Registers `s1pilot admin migrate-sqlite-to-pg --from file:… --to postgres://…`: copies every table of a SQLite
 * database into an empty Postgres database (ids preserved, secrets stay vault ciphertext) and prints the row
 * counts of both sides. Exit codes: 0 identical counts, 1 mismatch, 3 configuration / connection errors.
 * The target URL may also come from `S1PILOT_PG_URL` so credentials stay out of shell history.
 */
export function registerAdminCommands(program: Command, deps: CliDeps): void {
  const admin = program.command('admin').description('Administration tasks for team deployments');

  admin
    .command('migrate-sqlite-to-pg')
    .description('Copy all data from a SQLite database into an empty Postgres database (team mode)')
    .requiredOption('--from <url>', 'SQLite database: file:./.s1pilot/data.db or a path')
    .option('--to <url>', 'Postgres URL, postgres://user:pass@host:5432/db (or set S1PILOT_PG_URL)')
    .option('--json', 'print the result as JSON')
    .action(async (opts: MigrateOptions) => {
      try {
        const to = opts.to ?? deps.env['S1PILOT_PG_URL'];
        if (!to || !isPostgresUrl(to)) {
          throw new S1PilotError('CONFIG_ERROR', '--to must be a postgres:// URL (or set S1PILOT_PG_URL)');
        }
        if (isPostgresUrl(opts.from)) throw new S1PilotError('CONFIG_ERROR', '--from must be a SQLite database');
        const source = openDb({ url: opts.from });
        try {
          const target = await openPgDb({ url: to });
          try {
            const result = await copySqliteToPg(source, target);
            if (opts.json) {
              deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
            } else {
              for (const t of result.tables) {
                deps.stdout(`${t.table.padEnd(22)} ${String(t.source).padStart(8)} -> ${String(t.target).padStart(8)}${t.source === t.target ? '' : '  MISMATCH'}\n`);
              }
              const total = result.tables.reduce((n, t) => n + t.source, 0);
              deps.stdout(`${result.identical ? 'Copied' : 'Copied with mismatches:'} ${total} rows in ${result.tables.length} tables.\n`);
            }
            deps.setExitCode(result.identical ? 0 : 1);
          } finally {
            await target.close();
          }
        } finally {
          source.close();
        }
      } catch (error) {
        if (error instanceof S1PilotError) {
          deps.stderr(`${error.message}\n`);
          deps.setExitCode(3);
          return;
        }
        // Connection problems of the pg driver are configuration problems for the operator, not crashes.
        const message = error instanceof Error ? error.message : String(error);
        deps.stderr(`Migration failed: ${message}\n`);
        deps.setExitCode(3);
      }
    });
}
