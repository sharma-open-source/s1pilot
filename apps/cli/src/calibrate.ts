import { join, resolve } from 'node:path';

import { openDb, repos } from '@s1pilot/db';
import { ModelSettingsSchema, S1PilotError } from '@s1pilot/domain';
import { fitProject } from '@s1pilot/server';
import { PROJECT_DIR, syncDir } from '@s1pilot/sync';
import type { Command } from 'commander';

import type { CliDeps } from './program.js';

interface CalibrateOptions {
  project: string;
  dir: string;
  db?: string;
  json?: boolean;
}

/**
 * Registers `s1pilot calibrate --project SHOP`: fits temperature scaling from the project's reviewed
 * outcomes and prints the fitted models and the threshold suggestion. Thresholds are never changed here;
 * apply the suggestion from Analytics -> AI model quality.
 */
export function registerCalibrateCommand(program: Command, deps: CliDeps): void {
  program
    .command('calibrate')
    .description('Fit confidence calibration from human review outcomes (suggests thresholds, never applies them)')
    .requiredOption('--project <key>', 'project key, e.g. SHOP')
    .option('--dir <dir>', `project directory containing ${PROJECT_DIR}/`, '.')
    .option('--db <file>', `database file (default: <dir>/${PROJECT_DIR}/data.db)`)
    .option('--json', 'print the result as JSON')
    .action(async (opts: CalibrateOptions) => {
      const db = openDb({ url: opts.db ?? join(syncDir(resolve(opts.dir)), 'data.db') });
      try {
        const project = (await repos.projects.list(db)).find((p) => p.key === opts.project);
        if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `No project with key ${opts.project}`);
        const workspace = ModelSettingsSchema.safeParse(await repos.settings.get(db, 'workspace.modelSettings'));
        const thresholds = (project.modelSettings ?? (workspace.success ? workspace.data : undefined))?.thresholds ?? {
          pass: 0.8,
          fail: 0.2,
        };
        const state = await fitProject(db, project.id, thresholds);
        if (opts.json) {
          deps.stdout(`${JSON.stringify(state, null, 2)}\n`);
        } else {
          deps.stdout(`Fitted ${state.models.length} calibration model(s) from ${state.samples} reviewed decision(s).\n`);
          for (const m of state.models) {
            deps.stdout(`  ${m.key}  T=${m.T.toFixed(2)}  n=${m.n}  ECE ${m.eceBefore.toFixed(3)} -> ${m.eceAfter.toFixed(3)}\n`);
          }
          if (state.models.length === 0) deps.stdout('Not enough reviewed decisions yet (50 per bucket); probabilities are used as-is.\n');
          deps.stdout(
            state.suggestion
              ? `Suggested thresholds: pass >= ${state.suggestion.pass}, fail <= ${state.suggestion.fail} (false-pass ${(state.suggestion.falsePassRate * 100).toFixed(1)}% on ${state.suggestion.n}). Not applied; confirm in Analytics.\n`
              : 'No threshold suggestion (not enough reviewed data or the 1% false-pass target is not reachable).\n',
          );
        }
        deps.setExitCode(0);
      } catch (error) {
        if (!(error instanceof S1PilotError)) throw error;
        deps.stderr(`${error.message}\n`);
        deps.setExitCode(3);
      } finally {
        db.close();
      }
    });
}
