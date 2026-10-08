import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { S1PilotError } from '@s1pilot/domain';
import { buildApp, loadConfig, type ServerConfig } from '@s1pilot/server';
import type { Command } from 'commander';
import type { FastifyInstance } from 'fastify';

import type { CliDeps } from './program.js';

/** Options of `s1pilot ui`. */
export interface UiOptions {
  /** TCP port; 0 picks a free one. Default 5317. */
  port?: number;
  /** Data directory (database, artifacts, master key). Default: `./.s1pilot` when present, else `~/.s1pilot`. */
  dataDir?: string;
  /** Do not open a browser window. */
  open?: boolean;
  /** Directory of the built web app. Default: `dist/web` next to the CLI bundle. */
  webDist?: string;
  /** In-process workers executing runs. Default 1. */
  workers?: number;
  /** Server log level. Default `warn`. */
  logLevel?: ServerConfig['logLevel'];
}

/** A running local app. */
export interface UiHandle {
  /** `http://127.0.0.1:<port>` */
  url: string;
  app: FastifyInstance;
  /** Stops the workers, the server and the database. */
  close: () => Promise<void>;
}

/** Where the packed CLI keeps the web app (`dist/web`); in the monorepo build it is copied there by `scripts/copy-assets.mjs`. */
export function defaultWebDist(): string {
  return fileURLToPath(new URL('./web', import.meta.url));
}

/** Opens `url` in the default browser. Failures are ignored: the URL is printed anyway. */
export function openInBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // no browser available
  }
}

/**
 * Starts the whole app in this process: API, run queue + workers and the static web build, then (unless
 * `open === false`) opens the browser through `deps.openBrowser`.
 * @throws S1PilotError `WEB_DIST_MISSING` when the web build cannot be found.
 */
export async function startUi(opts: UiOptions, deps: Pick<CliDeps, 'openBrowser' | 'stdout' | 'env'>): Promise<UiHandle> {
  const webDist = opts.webDist ?? defaultWebDist();
  if (!existsSync(webDist)) {
    throw new S1PilotError('WEB_DIST_MISSING', `The web app build was not found at ${webDist}. Run "pnpm build" first.`, { webDist });
  }
  const config = loadConfig(
    {
      port: opts.port ?? 5317,
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      workers: opts.workers ?? 1,
      logLevel: opts.logLevel ?? 'warn',
    },
    deps.env,
  );
  const app = await buildApp(config, { dev: false, webDist });
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    await app.close();
    throw new S1PilotError('PORT_IN_USE', `Cannot listen on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}. Use --port to pick another one.`, {
      port: config.port,
    });
  }
  const url = `http://${config.host}:${(app.server.address() as AddressInfo).port}`;
  deps.stdout(`s1pilot is running at ${url}\nData directory: ${config.dataDir}\nPress Ctrl+C to stop.\n`);
  if (opts.open !== false) deps.openBrowser(url);
  return { url, app, close: () => app.close() };
}

/** Registers `s1pilot ui`. */
export function registerUiCommand(program: Command, deps: CliDeps): void {
  program
    .command('ui')
    .description('Start the local web app (API, run workers and UI) and open it in the browser')
    .option('--port <n>', 'port to listen on', (v) => Number.parseInt(v, 10), 5317)
    .option('--data-dir <dir>', 'data directory (default: ./.s1pilot if it exists, else ~/.s1pilot)')
    .option('--no-open', 'do not open a browser window')
    .action(async (opts: { port: number; dataDir?: string; open: boolean }) => {
      let handle: UiHandle;
      try {
        handle = await startUi({ port: opts.port, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), open: opts.open }, deps);
      } catch (error) {
        if (!(error instanceof S1PilotError)) throw error;
        deps.stderr(`${error.message}\n`);
        deps.setExitCode(3);
        return;
      }
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void handle.close().finally(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
