import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb } from '@s1pilot/db';
import { RemoteWorker, buildApp, createApiToken, loadConfig } from '@s1pilot/server';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram } from './program.js';
import { resolveWorkerSettings } from './worker.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('resolveWorkerSettings', () => {
  it('reads flags, then the environment, and validates them', () => {
    expect(resolveWorkerSettings({ server: 'http://s:1', token: 't', concurrency: 2, labels: 'gpu, eu,gpu' }, {})).toEqual({
      server: 'http://s:1',
      token: 't',
      concurrency: 2,
      labels: ['gpu', 'eu'],
    });
    expect(resolveWorkerSettings({}, { S1PILOT_SERVER_URL: 'https://s', S1PILOT_WORKER_TOKEN: 'tok', S1PILOT_WORKER_LABELS: 'gpu' })).toMatchObject({
      server: 'https://s',
      token: 'tok',
      labels: ['gpu'],
      concurrency: 1,
    });
    expect(() => resolveWorkerSettings({ token: 't' }, {})).toThrow(/--server/);
    expect(() => resolveWorkerSettings({ server: 'http://s' }, {})).toThrow(/--token/);
    expect(() => resolveWorkerSettings({ server: 'ftp://s', token: 't' }, {})).toThrow(/http/);
    expect(() => resolveWorkerSettings({ server: 'http://s', token: 't', labels: 'bad label' }, {})).toThrow(/Invalid label/);
    expect(() => resolveWorkerSettings({ server: 'http://s', token: 't', concurrency: 0 }, {})).toThrow(/concurrency/);
  });
});

describe('s1pilot worker', () => {
  it('registers --server, --token, --concurrency, --labels and --name', () => {
    const worker = buildProgram().commands.find((c) => c.name() === 'worker');
    expect(worker?.options.map((o) => o.long)).toEqual(['--server', '--token', '--concurrency', '--labels', '--name']);
  });

  it('reports a missing server with exit code 3', async () => {
    const err: string[] = [];
    let code = 0;
    const program = buildProgram({ env: {}, stderr: (t) => err.push(t), setExitCode: (c) => (code = c), exitOverride: true });
    await program.parseAsync(['node', 's1pilot', 'worker', '--token', 'x']);
    expect(code).toBe(3);
    expect(err.join('')).toContain('--server');
  });

  it('a worker registers with a real server and shows up in its registry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 's1p-cliw-'));
    const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 3).toString('base64') }) });
    const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
    const app = await buildApp(config, { db, workers: 0, scheduler: false, trackerSync: false, dev: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { token } = await createApiToken(db, { name: 'w', scopes: ['runs:write'], createdBy: 'test' });
    const addr = app.server.address();
    const worker = new RemoteWorker({ server: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, token, labels: ['gpu'], concurrency: 2, pollMs: 50 });
    cleanups.push(async () => {
      await worker.stop();
      await app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await worker.start();
    const res = await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/trpc/workspace.workers`);
    const body = (await res.json()) as { result: { data: { remote: Array<{ id: string; labels: string[]; concurrency: number }> } } };
    expect(body.result.data.remote).toMatchObject([{ id: worker.id, labels: ['gpu'], concurrency: 2 }]);
  });
});
