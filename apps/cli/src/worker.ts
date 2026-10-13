import { S1PilotError, WorkerLabelSchema } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { RemoteWorker } from '@s1pilot/server';
import type { Command } from 'commander';

import type { CliDeps } from './program.js';
import { getVersion } from './program.js';

/** Options of `s1pilot worker`. */
export interface WorkerCommandOptions {
  server?: string;
  token?: string;
  concurrency?: number;
  labels?: string;
  name?: string;
}

/** Validated worker settings: flags first, then `S1PILOT_SERVER_URL`, `S1PILOT_WORKER_TOKEN`, `S1PILOT_WORKER_LABELS`. */
export interface WorkerSettings {
  server: string;
  token: string;
  concurrency: number;
  labels: string[];
  name?: string;
}

/**
 * Resolves and validates the worker settings. The token should come from the environment (flags show up in process
 * lists); it is never printed.
 * @throws S1PilotError `CONFIG_ERROR` for a missing or invalid value.
 */
export function resolveWorkerSettings(opts: WorkerCommandOptions, env: NodeJS.ProcessEnv): WorkerSettings {
  const server = opts.server ?? env['S1PILOT_SERVER_URL'];
  const token = opts.token ?? env['S1PILOT_WORKER_TOKEN'];
  if (!server) throw new S1PilotError('CONFIG_ERROR', 'Missing --server (or S1PILOT_SERVER_URL): the URL of the s1pilot server');
  if (!/^https?:\/\//.test(server)) throw new S1PilotError('CONFIG_ERROR', `--server must be an http(s) URL, got "${server}"`);
  if (!token) throw new S1PilotError('CONFIG_ERROR', 'Missing --token (or S1PILOT_WORKER_TOKEN): an API token with the runs:write scope (Settings › API tokens)');
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new S1PilotError('CONFIG_ERROR', '--concurrency must be an integer from 1 to 64');
  const labels = (opts.labels ?? env['S1PILOT_WORKER_LABELS'] ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (const l of labels) {
    if (!WorkerLabelSchema.safeParse(l).success) throw new S1PilotError('CONFIG_ERROR', `Invalid label "${l}": use letters, digits, dot, dash or underscore`);
  }
  return { server, token, concurrency, labels: [...new Set(labels)], ...(opts.name ? { name: opts.name } : {}) };
}

/** Registers `s1pilot worker`. */
export function registerWorkerCommand(program: Command, deps: CliDeps): void {
  program
    .command('worker')
    .description('Run test jobs for a remote s1pilot server (register, lease jobs by label, upload results and artifacts)')
    .option('--server <url>', 'URL of the s1pilot server (or S1PILOT_SERVER_URL)')
    .option('--token <token>', 'API token with the runs:write scope; prefer S1PILOT_WORKER_TOKEN so it stays out of process lists')
    .option('--concurrency <n>', 'jobs to run at the same time', (v) => Number.parseInt(v, 10), 1)
    .option('--labels <list>', 'comma-separated labels of this worker, e.g. gpu,eu (or S1PILOT_WORKER_LABELS)')
    .option('--name <name>', 'name shown in Settings › Workers (default: the worker id)')
    .action(async (opts: WorkerCommandOptions) => {
      let settings: WorkerSettings;
      try {
        settings = resolveWorkerSettings(opts, deps.env);
      } catch (error) {
        if (!(error instanceof S1PilotError)) throw error;
        deps.stderr(`${error.message}\n`);
        deps.setExitCode(3);
        return;
      }
      const worker = new RemoteWorker({
        server: settings.server,
        token: settings.token,
        concurrency: settings.concurrency,
        labels: settings.labels,
        version: getVersion(),
        log: createLogger({ name: 's1pilot-worker', level: 'info' }),
        ...(settings.name ? { name: settings.name } : {}),
      });
      try {
        await worker.start();
      } catch (error) {
        deps.stderr(`Cannot register with ${settings.server}: ${error instanceof Error ? error.message : String(error)}\n`);
        deps.setExitCode(3);
        return;
      }
      deps.stdout(
        `s1pilot worker ${worker.id} connected to ${settings.server} (labels: ${settings.labels.join(', ') || 'none'}, concurrency: ${settings.concurrency}).\nPress Ctrl+C to stop.\n`,
      );
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void worker.stop().finally(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
