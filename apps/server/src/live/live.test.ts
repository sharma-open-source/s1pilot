import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { TestCaseFileSchema, newId, type DecisionModel, type RunEvent } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { launchBrowser } from '@s1pilot/runner';
import { loadCaseFile } from '@s1pilot/sync';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import type { ModelFactory } from '../worker/models.js';
import type { ServerRuntime } from '../worker/runtime.js';
import { runtimeFor } from '../worker/runtime.js';

import { decodeFrame, encodeFrame } from './frame.js';
import { ScreencastManager } from './screencast.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../../fixtures/sites/cases/shop/', import.meta.url));
const makeCaller = createCallerFactory(appRouter);
const VARS = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };

let fixture: FixtureServer;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A WebSocket client that records everything it receives. */
class Probe {
  readonly texts: Array<Record<string, unknown>> = [];
  readonly frames: Buffer[] = [];
  closeCode: number | undefined;
  readonly ws: WebSocket;
  private readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) this.frames.push(data as Buffer);
      else this.texts.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    cleanups.push(() => this.ws.close());
  }

  ready(): Promise<void> {
    return this.opened;
  }

  async until(pred: () => boolean, timeoutMs = 90_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for websocket messages');
      await sleep(20);
    }
  }

  get events(): RunEvent[] {
    return this.texts.filter((m) => m['type'] === 'event').map((m) => m['event'] as RunEvent);
  }
}

function mockFactory(delayMs = 0): ModelFactory {
  return (settings) => {
    const mock = new MockDecisionModel({ fallback: mockResolver(loadMockScript(join(casesDir, 'tc-042.mock.json'))) });
    const s1: DecisionModel = {
      capabilities: mock.capabilities,
      async decide(req) {
        if (delayMs) await sleep(delayMs);
        return mock.decide(req);
      },
    };
    return { s1, thresholds: settings.thresholds, modelName: 'mock' };
  };
}

async function startServer(opts: { delayMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-live-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
  const log = createLogger({ level: 'silent' });
  const app: FastifyInstance = await buildApp(config, { db, workers: 0, workerOptions: { createModels: mockFactory(opts.delayMs), pollMs: 50 } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const runtime: ServerRuntime = runtimeFor({ db, config, log });
  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
  const [dev] = await repos.environments.listByProject(db, project.id);
  if (!dev) throw new Error('no default environment');
  await repos.environments.update(db, dev.id, {
    variables: Object.entries(VARS).map(([key, value]) => ({ key, value, secret: false, source: 'inline' as const })),
  });
  await api.models.updateSettings({
    target: 'SHOP',
    settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
  });
  const file = TestCaseFileSchema.omit({ key: true }).parse(loadCaseFile(join(casesDir, 'tc-042.yaml')));
  const tc = await api.cases.create({ projectKey: 'SHOP', ...file });
  const port = (app.server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  const startRun = () => api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
  return { app, db, runtime, api, project, url, startRun };
}

describe('frame codec', () => {
  it('round-trips the header', () => {
    const data = Buffer.from([0xff, 0xd8, 1, 2, 3]);
    const out = decodeFrame(encodeFrame({ resultId: 'abc123', seq: 7, width: 1280, height: 720, data }));
    expect(out).toMatchObject({ resultId: 'abc123', seq: 7, width: 1280, height: 720 });
    expect(out.data.equals(data)).toBe(true);
    expect(() => decodeFrame(Buffer.alloc(3))).toThrow();
  });
});

describe('/ws/runs/:runId', () => {
  it('delivers ordered events from run.started to run.finished, with element overlay data and workspace updates', async () => {
    const s = await startServer();
    const created = await s.startRun();
    const run = new Probe(`${s.url}/ws/runs/${created.id}`);
    const workspace = new Probe(`${s.url}/ws/workspace`);
    await run.until(() => run.texts.length >= 1 && workspace.texts.length >= 1);
    expect(run.texts[0]).toMatchObject({ type: 'snapshot', run: { id: created.id, status: 'queued' }, currentCase: null, steps: [], lastDecision: null });
    expect(workspace.texts[0]).toEqual({ type: 'workspace', liveRuns: 0, reviewCount: 0 });

    s.runtime.workers.start(1);
    await run.until(() => run.events.some((e) => e.type === 'run.finished'));
    const types = run.events.map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types.at(-1)).toBe('run.finished');
    expect(types.filter((t) => t === 'run.started' || t === 'run.finished')).toHaveLength(2);
    expect(types.indexOf('case.started')).toBeLessThan(types.indexOf('step.started'));
    expect(types.lastIndexOf('step.finished')).toBeLessThan(types.indexOf('case.finished'));
    expect(types.indexOf('case.finished')).toBeLessThan(types.indexOf('run.finished'));
    const finishedSteps = run.events.filter((e) => e.type === 'step.finished').map((e) => (e as { stepIndex: number }).stepIndex);
    expect(finishedSteps).toEqual([0, 1, 2, 3]);
    expect(run.events.every((e) => e.runId === created.id)).toBe(true);

    const overlay = run.events.find((e) => e.type === 'observation.elements');
    expect(overlay).toBeDefined();
    if (overlay?.type !== 'observation.elements') throw new Error('unreachable');
    expect(overlay.elements.length).toBeGreaterThan(0);
    expect(overlay.elements[0]).toMatchObject({ id: expect.any(String), role: expect.any(String), box: { x: expect.any(Number), w: expect.any(Number) } });
    expect(overlay.chosenId === undefined || overlay.elements.some((e) => e.id === overlay.chosenId)).toBe(true);

    // Workspace channel: live count goes up and back down, status changes are announced.
    await workspace.until(() => workspace.texts.some((m) => m['type'] === 'run.status' && m['status'] === 'passed'));
    await workspace.until(() => workspace.texts.some((m, i) => i > 0 && m['type'] === 'workspace' && m['liveRuns'] === 0));
    expect(workspace.texts.filter((m) => m['type'] === 'run.status').map((m) => m['status'])).toEqual(['running', 'passed']);
    expect(workspace.texts.some((m) => m['type'] === 'workspace' && m['liveRuns'] === 1)).toBe(true);
  });

  it('gives a reconnecting client a snapshot of the running case, then continues without gaps', async () => {
    const s = await startServer({ delayMs: 150 });
    const created = await s.startRun();
    const first = new Probe(`${s.url}/ws/runs/${created.id}`);
    await first.ready();
    s.runtime.workers.start(1);
    await first.until(() => first.events.filter((e) => e.type === 'step.finished').length >= 1);
    first.ws.close();

    const second = new Probe(`${s.url}/ws/runs/${created.id}`);
    await second.until(() => second.texts.length >= 1);
    const snap = second.texts[0] as { type: string; run: { status: string }; currentCase: { caseResultId: string } | null; steps: Array<{ stepIndex: number; status: string }>; lastDecision: unknown };
    expect(snap.type).toBe('snapshot');
    expect(snap.run.status).toBe('running');
    expect(snap.currentCase).not.toBeNull();
    expect(snap.steps.length).toBeGreaterThanOrEqual(1);
    expect(snap.steps[0]).toMatchObject({ stepIndex: 0, status: 'passed' });
    expect(snap.lastDecision).not.toBeNull();

    await second.until(() => second.events.some((e) => e.type === 'run.finished'));
    // Nothing the snapshot already covered is replayed, and the tail is complete.
    const done = new Set(snap.steps.filter((x) => x.status !== 'running').map((x) => x.stepIndex));
    const replayed = second.events.filter((e) => e.type === 'step.finished' && done.has(e.stepIndex));
    expect(replayed).toEqual([]);
    expect(second.events.at(-1)?.type).toBe('run.finished');
    expect(second.events.filter((e) => e.type === 'step.finished').length + done.size).toBe(4);
  });

  it('closes with 1008 for an unknown run', async () => {
    const s = await startServer();
    const probe = new Probe(`${s.url}/ws/runs/${newId()}`);
    await probe.until(() => probe.closeCode !== undefined, 5_000);
    expect(probe.closeCode).toBe(1008);
  });

  it('streams screencast frames only while subscribed', async () => {
    const s = await startServer();
    const browser = await launchBrowser('chromium');
    cleanups.push(() => browser.close());
    const page = await browser.newPage();
    await page.setContent('<body><div id="n"></div><script>let i=0;setInterval(()=>{document.getElementById("n").textContent=String(i++)},16)</script></body>');
    const created = await s.startRun();
    const release = s.runtime.live.screencast.attach(created.id, 'result-1', page);
    cleanups.push(() => release());
    expect(s.runtime.live.screencast.activeCount).toBe(0);

    const run = new Probe(`${s.url}/ws/runs/${created.id}`);
    await run.until(() => run.frames.length >= 3, 15_000);
    const first = run.frames[0];
    if (!first) throw new Error('no frame');
    const frame = decodeFrame(first);
    expect(frame.resultId).toBe('result-1');
    expect(frame.seq).toBe(1);
    expect(frame.width).toBeGreaterThan(0);
    expect([...frame.data.subarray(0, 2)]).toEqual([0xff, 0xd8]); // JPEG
    expect(s.runtime.live.screencast.activeCount).toBe(1);

    run.ws.close();
    await sleep(1000);
    expect(s.runtime.live.screencast.activeCount).toBe(0);
    expect(s.runtime.live.clientCount(created.id)).toBe(0);
  });
});

describe('ScreencastManager', () => {
  it('caps the Chromium screencast at 10 fps and stops within 1 s of the last unsubscribe', async () => {
    const browser = await launchBrowser('chromium');
    cleanups.push(() => browser.close());
    const page = await browser.newPage();
    await page.setContent('<body><div id="n"></div><script>let i=0;setInterval(()=>{document.getElementById("n").textContent=String(i++)},8)</script></body>');
    let count = 0;
    const manager = new ScreencastManager({ onFrame: () => void count++ });
    const release = manager.attach('r1', 'c1', page);
    cleanups.push(() => release());
    await sleep(300);
    expect(count).toBe(0); // no subscriber, no frames

    manager.setDemand('r1', 1);
    const t0 = Date.now();
    while (count < 5 && Date.now() - t0 < 15_000) await sleep(20);
    expect(count).toBeGreaterThanOrEqual(5);
    const startCount = count;
    const windowStart = Date.now();
    await sleep(2000);
    const fps = (count - startCount) / ((Date.now() - windowStart) / 1000);
    expect(fps).toBeLessThanOrEqual(11);

    manager.setDemand('r1', 0);
    const atStop = count;
    await sleep(1000);
    expect(count).toBe(atStop);
    expect(manager.activeCount).toBe(0);

    // Subscribing again resumes the stream.
    manager.setDemand('r1', 1);
    const t1 = Date.now();
    while (count < atStop + 2 && Date.now() - t1 < 15_000) await sleep(20);
    expect(count).toBeGreaterThanOrEqual(atStop + 2);
    manager.setDemand('r1', 0);
  });

  it('falls back to screenshots for non-Chromium browsers', async () => {
    let shots = 0;
    const page = {
      context: () => ({ browser: () => ({ browserType: () => ({ name: () => 'webkit' }) }) }),
      screenshot: async () => {
        shots++;
        return Buffer.from([0xff, 0xd8, 0xff]);
      },
      viewportSize: () => ({ width: 800, height: 600 }),
      once: () => undefined,
    };
    const frames: Array<{ width: number; height: number; seq: number }> = [];
    const manager = new ScreencastManager({ fallbackIntervalMs: 40, onFrame: (_run, f) => void frames.push(f) });
    manager.attach('r1', 'c1', page as never);
    await sleep(150);
    expect(shots).toBe(0);
    manager.setDemand('r1', 2);
    await sleep(300);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0]).toMatchObject({ width: 800, height: 600, seq: 1 });
    manager.setDemand('r1', 0);
    await sleep(60);
    const n = shots;
    await sleep(200);
    expect(shots).toBe(n);
  });
});
