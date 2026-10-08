import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import {
  TestCaseFileSchema,
  type DecideAnswer,
  type DecisionModel,
  type DecisionRecord,
  type RunEvent,
} from '@s1pilot/domain';
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
import { runtimeFor, type ServerRuntime } from '../worker/runtime.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../../fixtures/sites/cases/shop/', import.meta.url));
const makeCaller = createCallerFactory(appRouter);
const VARS = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** A WebSocket client that records what it receives and can send control messages. */
class Probe {
  readonly texts: Array<Record<string, unknown>> = [];
  readonly ws: WebSocket;
  private readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) this.texts.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    cleanups.push(() => this.ws.close());
  }

  async send(msg: Record<string, unknown>): Promise<void> {
    await this.opened;
    this.ws.send(JSON.stringify(msg));
  }

  async until(pred: () => boolean, timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs)
        throw new Error('timed out waiting for websocket messages');
      await sleep(20);
    }
  }

  get events(): RunEvent[] {
    return this.texts.filter((m) => m['type'] === 'event').map((m) => m['event'] as RunEvent);
  }

  acks(): number {
    return this.texts.filter((m) => m['type'] === 'control.ack').length;
  }

  needed(): Extract<RunEvent, { type: 'escalation.needed' }> | undefined {
    return this.events.find(
      (e): e is Extract<RunEvent, { type: 'escalation.needed' }> => e.type === 'escalation.needed',
    );
  }
}

/** Scripted mock: the first `next_action` answer is made unsure, so an attended run must ask a human. */
function lowConfidenceOnce(sure = false): ModelFactory {
  return (settings) => {
    const mock = new MockDecisionModel({
      fallback: mockResolver(loadMockScript(join(casesDir, 'tc-042.mock.json'))),
    });
    let unsure = !sure;
    const s1: DecisionModel = {
      capabilities: mock.capabilities,
      async decide(req) {
        const answers = await mock.decide(req);
        const next = answers['next_action'];
        if (unsure && next && 'step_done' in req.questions) {
          unsure = false;
          const lowered: DecideAnswer = { ...next, confidence: 0.3 };
          return { ...answers, next_action: lowered };
        }
        return answers;
      },
    };
    return { s1, thresholds: settings.thresholds, modelName: 'mock' };
  };
}

async function startServer(
  opts: { escalationTimeoutMin?: number; mode?: 'local' | 'team'; delayMs?: number; sure?: boolean } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-ctl-'));
  const db: Db = openDb({
    url: ':memory:',
    crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }),
  });
  const config = loadConfig(
    {
      dataDir,
      logLevel: 'silent',
      workers: 0,
      ...(opts.escalationTimeoutMin ? { escalationTimeoutMin: opts.escalationTimeoutMin } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
    },
    {},
  );
  const log = createLogger({ level: 'silent' });
  const browsers: Array<Awaited<ReturnType<typeof launchBrowser>>> = [];
  const base = lowConfidenceOnce(opts.sure);
  const factory: ModelFactory = (settings, redactor) => {
    const models = base(settings, redactor);
    if (!opts.delayMs) return models;
    const inner = models.s1;
    return {
      ...models,
      s1: {
        capabilities: inner.capabilities,
        decide: async (req) => {
          await sleep(opts.delayMs ?? 0);
          return inner.decide(req);
        },
      },
    };
  };
  const app: FastifyInstance = await buildApp(config, {
    db,
    workers: 0,
    launchHeaded: async () => {
      const b = await launchBrowser('chromium'); // headless stand-in for the visible window
      browsers.push(b);
      return b;
    },
    workerOptions: {
      createModels: factory,
      pollMs: 50,
      launch: async (name) => {
        const b = await launchBrowser(name);
        browsers.push(b);
        return b;
      },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(async () => {
    await app.close();
    await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const runtime: ServerRuntime = runtimeFor({ db, config, log });
  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({
    name: 'Shop',
    key: 'SHOP',
    baseUrl: `${fixture.url}/shop`,
  });
  const [dev] = await repos.environments.listByProject(db, project.id);
  if (!dev) throw new Error('no default environment');
  await repos.environments.update(db, dev.id, {
    variables: Object.entries(VARS).map(([key, value]) => ({
      key,
      value,
      secret: false,
      source: 'inline' as const,
    })),
  });
  await api.models.updateSettings({
    target: 'SHOP',
    settings: {
      system1: { adapter: 'mock', model: 'mock' },
      thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
      dualOrderSensitive: false,
    },
  });
  const file = TestCaseFileSchema.omit({ key: true }).parse(
    loadCaseFile(join(casesDir, 'tc-042.yaml')),
  );
  const tc = await api.cases.create({ projectKey: 'SHOP', ...file });
  const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const startRun = (attended: boolean) =>
    api.runs.create({
      projectKey: 'SHOP',
      caseKeys: [tc.key],
      environment: 'dev',
      attended,
      mode: 'explore',
    });
  const connect = (runId: string) => new Probe(`${url}/ws/runs/${runId}`);
  const contexts = (): number => browsers.flatMap((b) => b.contexts()).length;
  return { db, runtime, api, tc, env: dev, startRun, connect, contexts };
}

const allDecisions = async (db: Db, runId: string): Promise<DecisionRecord[]> => {
  const cases = await repos.results.listCases(db, runId);
  const steps = (await Promise.all(cases.map((c) => repos.results.listSteps(db, c.id)))).flat();
  return steps.flatMap((s) => s.decisions);
};

const topOf = (probabilities: Record<string, number> | undefined): string => {
  const top = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!top) throw new Error('no top choice');
  return top;
};

describe('human-in-the-loop control', () => {
  it('pauses on low confidence; approve continues and the learned script keeps the approved path', async () => {
    const s = await startServer();
    const created = await s.startRun(true);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.needed() !== undefined);
    const needed = probe.needed();
    if (!needed) throw new Error('unreachable');
    expect(needed).toMatchObject({
      reason: 'low-confidence',
      to: 'human',
      stepIndex: 0,
      question: expect.stringContaining('Which single action'),
      thresholds: { act: 0.8, escalate: 0.4 },
    });
    expect(needed.options.length).toBeGreaterThan(1);
    expect(Object.keys(needed.probabilities ?? {}).length).toBeGreaterThan(1);

    // Paused: nothing moves on while nobody answers.
    await sleep(800);
    expect(probe.events.some((e) => e.type === 'step.finished')).toBe(false);
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('running');

    // A reconnecting client gets the open escalation in its snapshot.
    const late = s.connect(created.id);
    await late.until(() => late.texts.length > 0);
    expect((late.texts[0] as { pendingEscalations: unknown[] }).pendingEscalations).toHaveLength(1);

    const top = topOf(needed.probabilities);
    await probe.send({
      type: 'approve',
      escalationId: needed.escalationId,
      choice: top,
      saveToLearned: true,
    });
    await probe.until(() => probe.acks() >= 1);
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));

    expect(probe.events.find((e) => e.type === 'escalation.resolved')).toMatchObject({
      resolution: 'approved',
      chosen: top,
      escalationId: needed.escalationId,
    });
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('passed');

    const human = (await allDecisions(s.db, created.id)).filter((d) => d.escalatedTo === 'human');
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ chosen: top, decidedBy: 'local', via: 'live' });

    const script = await repos.learnedScripts.getFor(s.db, s.tc.id, s.env.id);
    expect(script).toBeDefined();
    expect(script?.actions.some((a) => a.stepIndex === 0)).toBe(true);

    // The decision made below the act threshold is also recorded for calibration.
    const reviews = await repos.reviews.list(s.db, { projectId: s.tc.projectId, kind: 'decision' });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ refId: needed.escalationId, status: 'approved' });
    expect(JSON.parse(reviews[0]?.note ?? '{}')).toMatchObject({
      humanChoice: top,
      decidedBy: 'local',
      via: 'live',
    });
  });

  it('does not save a learned script when approve says saveToLearned: false (tRPC path)', async () => {
    const s = await startServer();
    const created = await s.startRun(true);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.needed() !== undefined);
    const needed = probe.needed();
    if (!needed) throw new Error('unreachable');
    const top = topOf(needed.probabilities);
    await expect(
      s.api.runs.control({
        runId: created.id,
        message: { type: 'approve', escalationId: 'nope', choice: top, saveToLearned: false },
      }),
    ).rejects.toThrow(/No open escalation/);
    await expect(
      s.api.runs.control({
        runId: created.id,
        message: {
          type: 'approve',
          escalationId: needed.escalationId,
          choice: 'bogus',
          saveToLearned: false,
        },
      }),
    ).rejects.toThrow(/Unknown option/);
    await s.api.runs.control({
      runId: created.id,
      message: {
        type: 'approve',
        escalationId: needed.escalationId,
        choice: top,
        saveToLearned: false,
      },
    });
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('passed');
    expect(await repos.learnedScripts.getFor(s.db, s.tc.id, s.env.id)).toBeUndefined();
  });

  it('abort ends the run as cancelled and closes the browser contexts', async () => {
    const s = await startServer();
    const created = await s.startRun(true);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.needed() !== undefined);
    expect(s.contexts()).toBe(1);
    await probe.send({ type: 'abort' });
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('cancelled');
    const start = Date.now();
    while (s.contexts() > 0 && Date.now() - start < 10_000) await sleep(50);
    expect(s.contexts()).toBe(0);
    expect(s.runtime.human.pendingEscalations(created.id)).toEqual([]);
  });

  it('never asks a human in an unattended run: the step is blocked', async () => {
    const s = await startServer();
    const created = await s.startRun(false);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
    expect(probe.events.some((e) => e.type === 'escalation.needed')).toBe(false);
    const cases = await repos.results.listCases(s.db, created.id);
    expect(cases[0]?.verdict).toBe('blocked');
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('failed');
  });

  it('blocks the step when nobody answers within escalationTimeoutMin', async () => {
    const s = await startServer({ escalationTimeoutMin: 0.01 }); // 600 ms
    const created = await s.startRun(true);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
    expect(probe.events.find((e) => e.type === 'escalation.resolved')).toMatchObject({
      resolution: 'timed-out',
    });
    const cases = await repos.results.listCases(s.db, created.id);
    expect(cases[0]?.verdict).toBe('blocked');
  });

  it('pause holds the run before the next step and resume continues it', async () => {
    const s = await startServer({ delayMs: 200, sure: true });
    const created = await s.startRun(false);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.events.some((e) => e.type === 'step.started'));
    await probe.send({ type: 'pause' });
    await probe.until(() => probe.acks() >= 1);
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('paused');
    await sleep(1500);
    const finishedWhilePaused = probe.events.filter((e) => e.type === 'step.finished').length;
    await sleep(1500);
    expect(probe.events.filter((e) => e.type === 'step.finished').length).toBe(finishedWhilePaused);
    expect(finishedWhilePaused).toBeLessThan(4);
    await probe.send({ type: 'resume' });
    await probe.until(() => probe.acks() >= 2);
    expect((await repos.runs.get(s.db, created.id))?.status).not.toBe('paused');
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
  });

  it('takeover pauses the engine until release, then observes again and finishes', async () => {
    const s = await startServer();
    const created = await s.startRun(true);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.needed() !== undefined);

    await probe.send({ type: 'takeover' });
    await probe.until(() => probe.acks() >= 1);
    expect(s.contexts()).toBe(2); // the run's context and the human's window
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('paused');
    await sleep(500);
    expect(probe.events.some((e) => e.type === 'step.finished')).toBe(false);

    await probe.send({ type: 'release' });
    await probe.until(() => probe.events.some((e) => e.type === 'escalation.resolved'));
    expect(probe.events.find((e) => e.type === 'escalation.resolved')).toMatchObject({
      resolution: 'taken-over',
    });
    // The model is unsure only once, so after the fresh observation the run completes on its own.
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
    expect((await repos.runs.get(s.db, created.id))?.status).toBe('passed');
    const human = (await allDecisions(s.db, created.id)).filter((d) => d.escalatedTo === 'human');
    expect(human[0]).toMatchObject({ decidedBy: 'local', via: 'live' });
  });

  it('refuses takeover outside local mode and rejects malformed control messages', async () => {
    const s = await startServer({ mode: 'team' });
    const created = await s.startRun(true);
    const probe = s.connect(created.id);
    s.runtime.workers.start(1);
    await probe.until(() => probe.needed() !== undefined);
    await probe.send({ type: 'takeover' });
    await probe.send({ type: 'dance' });
    await probe.until(() => probe.texts.filter((m) => m['type'] === 'control.error').length >= 2);
    const errors = probe.texts.filter((m) => m['type'] === 'control.error');
    expect(errors.map((e) => e['code']).sort()).toEqual([
      'INVALID_MESSAGE',
      'TAKEOVER_UNAVAILABLE',
    ]);
    await probe.send({ type: 'abort' });
    await probe.until(() => probe.events.some((e) => e.type === 'run.finished'));
  });
});
