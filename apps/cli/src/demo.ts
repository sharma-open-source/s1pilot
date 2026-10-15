import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openDb } from '@s1pilot/db';
import { DecideRequestSchema, S1PilotError } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, MockScriptSchema, mockResolver, type MockScript } from '@s1pilot/providers';
import { importProject } from '@s1pilot/sync';
import type { Command } from 'commander';

import type { CliDeps } from './program.js';
import { startUi, type UiHandle, type UiOptions } from './ui.js';

/** Project key of the demo project. */
export const DEMO_PROJECT_KEY = 'DEMO';

/**
 * Steps of the ready-made demo test. Results are checked with deterministic assertions only (no plain-language
 * `expected`, which a model would verify), so a replay makes no model calls at all.
 */
const DEMO_STEPS = [
  { action: 'Open the "Classic Tee" product', assert: '{ type: urlMatches, pattern: "/shop/product/classic-tee" }', pick: ['[link] Classic Tee'] },
  {
    action: 'Choose colour Blue and size M, then add to cart',
    assert: '{ type: elementText, role: status, contains: "1" }',
    pick: ['[radio] Blue', '[radio] M', '[button] Add to cart'],
  },
] as const;

/** Oracle answers for the demo test on the fixture shop: the right option for each step, with high confidence. */
export const DEMO_SCRIPT: MockScript = MockScriptSchema.parse({
  steps: Object.fromEntries(DEMO_STEPS.map((s) => [s.action, [...s.pick]])),
  expected: 0.95,
});

/** A local stand-in for a System 1 server. */
export interface DemoModel {
  /** Base URL, e.g. `http://127.0.0.1:41233`. */
  url: string;
  /** Decision calls answered so far. */
  readonly calls: number;
  close(): Promise<void>;
}

/**
 * Starts a local server speaking the `systemone` wire format (`POST /v1/systemone`) that answers from the oracle
 * mock script. It only knows the demo test; it never reaches the network.
 */
export async function startDemoModel(script: MockScript = DEMO_SCRIPT): Promise<DemoModel> {
  const model = new MockDecisionModel({ fallback: mockResolver(script) });
  let calls = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET') return send(200, { data: [{ id: 'demo-oracle' }] });
      void (async () => {
        const parsed = DecideRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
        if (!parsed.success) return send(400, { error: 'bad request' });
        calls++;
        send(200, { answers: await model.decide(parsed.data) });
      })().catch((error: unknown) => send(500, { error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get calls() {
      return calls;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * Writes the demo project as a `.s1pilot/` folder under `dir`: the fixture shop as the `local` environment, the demo
 * model as System 1, and one ready test.
 */
export function writeDemoProject(dir: string, shopUrl: string, modelUrl: string): void {
  const root = join(dir, '.s1pilot');
  mkdirSync(join(root, 'suites', 'Demo'), { recursive: true });
  writeFileSync(
    join(root, 'project.yaml'),
    [
      `key: ${DEMO_PROJECT_KEY}`,
      'name: Demo shop',
      'defaultEnvironment: local',
      'environments:',
      '  - name: local',
      `    baseUrl: ${shopUrl}`,
      'model:',
      `  system1: { adapter: systemone, baseUrl: ${modelUrl}, model: demo-oracle }`,
      '  thresholds: { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 }',
      '',
    ].join('\n'),
  );
  const steps = DEMO_STEPS.map((s) => [`  - action: ${JSON.stringify(s.action)}`, '    assert:', `      - ${s.assert}`].join('\n'));
  writeFileSync(
    join(root, 'suites', 'Demo', 'demo-tc-1.yaml'),
    [
      `key: ${DEMO_PROJECT_KEY}-TC-1`,
      'title: Add a Classic Tee to the cart',
      'priority: P1',
      'type: e2e',
      'status: ready',
      'tags: [demo, smoke]',
      'steps:',
      ...steps,
      '',
    ].join('\n'),
  );
}

/** Options of `s1pilot demo`. */
export interface DemoOptions extends Pick<UiOptions, 'port' | 'open' | 'webDist' | 'workers' | 'logLevel'> {
  /** Data directory. Default: a new temporary directory, so every demo starts clean. */
  dataDir?: string;
  /** Port of the fixture shop; default 4400, or a free one when it is taken. */
  shopPort?: number;
}

/** A running demo: the app, the fixture shop and the demo model. */
export interface DemoHandle {
  ui: UiHandle;
  shop: FixtureServer;
  model: DemoModel;
  /** Page the browser opens: the demo project's test cases. */
  startUrl: string;
  close(): Promise<void>;
}

/**
 * Starts the zero-key demo: the bundled fixture shop, a local oracle System 1 model, and the app with a `DEMO` project
 * holding one ready test. Nothing reaches the network.
 */
export async function startDemo(opts: DemoOptions, deps: Pick<CliDeps, 'openBrowser' | 'stdout' | 'env'>): Promise<DemoHandle> {
  const dataDir = resolve(opts.dataDir ?? mkdtempSync(join(tmpdir(), 's1pilot-demo-')));
  const shop = await startFixtureServer({ port: opts.shopPort ?? 4400 }).catch(() => startFixtureServer());
  const model = await startDemoModel();
  const stopHelpers = async (): Promise<void> => {
    await model.close();
    await shop.close();
  };
  try {
    const projectDir = join(dataDir, 'demo-project');
    writeDemoProject(projectDir, `${shop.url}/shop`, model.url);
    const db = openDb({ url: join(dataDir, 'data.db') });
    try {
      // Re-running with the same --data-dir updates the shop and model URLs in place.
      await importProject(db, projectDir);
    } finally {
      db.close();
    }
    const ui = await startUi({ ...opts, dataDir, open: false }, deps);
    const startUrl = `${ui.url}/p/${DEMO_PROJECT_KEY}/cases`;
    deps.stdout(
      [
        '',
        `Demo shop:   ${shop.url}/shop`,
        `Demo model:  ${model.url} (scripted oracle, no API key; it only knows the demo test)`,
        '',
        'Try it: open "Add a Classic Tee to the cart", click Run now, then run it again.',
        'The first run explores with the model; the second replays the learned script with 0 model calls.',
        `Open ${startUrl}`,
        '',
      ].join('\n'),
    );
    if (opts.open !== false) deps.openBrowser(startUrl);
    return {
      ui,
      shop,
      model,
      startUrl,
      close: async () => {
        await ui.close();
        await stopHelpers();
      },
    };
  } catch (error) {
    await stopHelpers();
    throw error;
  }
}

/** Registers `s1pilot demo`. */
export function registerDemoCommand(program: Command, deps: CliDeps): void {
  program
    .command('demo')
    .description('Try s1pilot with no API key: starts a demo shop, a scripted model and the web app with a ready test')
    .option('--port <n>', 'port of the web app', (v) => Number.parseInt(v, 10), 5317)
    .option('--data-dir <dir>', 'data directory (default: a new temporary directory)')
    .option('--no-open', 'do not open a browser window')
    .action(async (opts: { port: number; dataDir?: string; open: boolean }) => {
      let handle: DemoHandle;
      try {
        handle = await startDemo({ port: opts.port, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), open: opts.open }, deps);
      } catch (error) {
        if (!(error instanceof S1PilotError)) throw error;
        deps.stderr(`${error.message}\n`);
        deps.setExitCode(3);
        return;
      }
      await new Promise<void>((done) => {
        const stop = (): void => {
          void handle.close().finally(done);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });
}
