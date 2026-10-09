import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { verifyWebhookSignature } from '@s1pilot/integrations';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { configureNotifications } from '../../notifications/service.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
const servers: Server[] = [];
afterEach(async () => {
  dbs.splice(0).forEach((d) => d.close());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

interface Hit {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
async function fake(status = 200): Promise<{ url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`, hits };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  configureNotifications(db, { retry: { sleep: () => Promise.resolve() }, approvalWaitMs: 30 });
  const config = loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot', logLevel: 'silent' }, {});
  const ctx = createContext({ db, config, log: createLogger({ level: 'silent' }) });
  const api = makeCaller(ctx);
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  return { api, db, ctx, project };
}

const summary = { passed: 1, failed: 1, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 };

describe('notifications', () => {
  it('sends a Slack message when a run finishes, honouring only-on-failure', async () => {
    const { api, db, ctx, project } = await setup();
    const slack = await fake();
    const ch = await api.notifications.channels.save({ name: 'Slack #qa', config: { kind: 'slack', webhookUrl: slack.url } });
    await api.notifications.rules.save({ channelId: ch.id, events: ['run.finished'], onlyOnFailure: true });
    await repos.runs.create(db, { id: 'ok1', projectId: project.id, trigger: 'manual', status: 'passed' });
    await repos.runs.create(db, { id: 'bad1', projectId: project.id, trigger: 'manual', status: 'failed', summary });
    const ts = new Date().toISOString();
    ctx.runtime.bus.emit({ type: 'run.finished', runId: 'ok1', ts, status: 'passed', summary });
    ctx.runtime.bus.emit({ type: 'run.finished', runId: 'bad1', ts, status: 'failed', summary });
    await until(() => slack.hits.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(slack.hits).toHaveLength(1);
    const msg = JSON.parse(slack.hits[0]?.body ?? '{}') as { text: string; blocks: Array<{ type: string; elements?: Array<{ url: string }> }> };
    expect(msg.text).toContain('Run failed');
    expect(msg.blocks.find((b) => b.type === 'actions')?.elements?.[0]?.url).toContain('/p/SHOP/runs/bad1');
    const log = await api.notifications.log();
    expect(log[0]).toMatchObject({ ok: true, attempts: 1, event: 'run.finished' });
  });

  it('signs outbound webhooks', async () => {
    const { api, db, ctx, project } = await setup();
    const hook = await fake();
    const ch = await api.notifications.channels.save({ name: 'CI hook', config: { kind: 'webhook', url: hook.url, secret: 'shared' } });
    await api.notifications.rules.save({ channelId: ch.id, projectKey: 'SHOP', events: ['run.finished'] });
    await repos.runs.create(db, { id: 'r1', projectId: project.id, trigger: 'manual', status: 'passed' });
    ctx.runtime.bus.emit({ type: 'run.finished', runId: 'r1', ts: new Date().toISOString(), status: 'passed', summary });
    await until(() => hook.hits.length === 1);
    const h = hook.hits[0] as Hit;
    expect(verifyWebhookSignature('shared', h.headers['x-s1pilot-timestamp'] as string, h.body, h.headers['x-s1pilot-signature'] as string)).toBe(true);
  });

  it('retries a failing endpoint 3 times, then logs the failure', async () => {
    const { api, db, ctx, project } = await setup();
    const bad = await fake(500);
    const ch = await api.notifications.channels.save({ name: 'Broken', config: { kind: 'teams', webhookUrl: bad.url } });
    await api.notifications.rules.save({ channelId: ch.id, events: ['run.finished'] });
    await repos.runs.create(db, { id: 'r1', projectId: project.id, trigger: 'manual', status: 'failed', summary });
    ctx.runtime.bus.emit({ type: 'run.finished', runId: 'r1', ts: new Date().toISOString(), status: 'failed', summary });
    await until(async () => (await api.notifications.log()).length === 1);
    expect(bad.hits).toHaveLength(4);
    expect((await api.notifications.log())[0]).toMatchObject({ ok: false, attempts: 4, error: 'HTTP 500', channelName: 'Broken' });
  });

  it('test send works and channel secrets are never returned', async () => {
    const { api } = await setup();
    const slack = await fake();
    const ch = await api.notifications.channels.save({ name: 'Slack', config: { kind: 'slack', webhookUrl: slack.url } });
    expect(JSON.stringify(await api.notifications.channels.list())).not.toContain(slack.url);
    expect((await api.notifications.channels.list())[0]?.secretsSet).toMatchObject({ webhookUrl: true });
    expect(await api.notifications.channels.test({ id: ch.id })).toMatchObject({ ok: true });
    expect(slack.hits).toHaveLength(1);
    // Updating without a secret keeps the stored one.
    await api.notifications.channels.save({ id: ch.id, name: 'Slack renamed', config: { kind: 'slack', channel: '#qa' } });
    expect(await api.notifications.channels.test({ id: ch.id })).toMatchObject({ ok: true });
    expect(slack.hits).toHaveLength(2);
  });

  it('notifies on defect.created, review.threshold and a long-waiting approval', async () => {
    const { api, db, ctx, project } = await setup();
    const hook = await fake();
    const ch = await api.notifications.channels.save({ name: 'All', config: { kind: 'webhook', url: hook.url } });
    await api.notifications.rules.save({ channelId: ch.id, events: ['defect.created', 'review.threshold', 'approval.required'], reviewThreshold: 2 });
    await api.defects.create({ projectKey: 'SHOP', title: 'Badge wrong', severity: 'S2' });
    await until(() => hook.hits.length === 1);
    expect(JSON.parse(hook.hits[0]?.body ?? '{}')).toMatchObject({ event: 'defect.created', data: { title: 'Badge wrong', severity: 'S2' } });

    for (let i = 0; i < 3; i++) await repos.reviews.create(db, { id: newId(), projectId: project.id, kind: 'verdict', refId: newId(), status: 'pending' });
    const { notifyReviewQueue } = await import('../../notifications/service.js');
    await notifyReviewQueue({ db, config: ctx.config, log: ctx.log }, project.id);
    await until(() => hook.hits.length === 2);
    expect(JSON.parse(hook.hits[1]?.body ?? '{}')).toMatchObject({ event: 'review.threshold', data: { pending: 3, threshold: 2 } });

    await repos.runs.create(db, { id: 'live1', projectId: project.id, trigger: 'manual', status: 'running' });
    ctx.runtime.bus.emit({ type: 'escalation.needed', runId: 'live1', ts: new Date().toISOString(), caseResultId: 'cr', stepIndex: 0, escalationId: 'e1', reason: 'low-confidence', to: 'human', options: [], question: 'Which button?' });
    await until(() => hook.hits.length === 3);
    expect(JSON.parse(hook.hits[2]?.body ?? '{}')).toMatchObject({ event: 'approval.required', data: { question: 'Which button?' } });

    // An answered escalation sends nothing.
    ctx.runtime.bus.emit({ type: 'escalation.needed', runId: 'live1', ts: new Date().toISOString(), caseResultId: 'cr', stepIndex: 0, escalationId: 'e2', reason: 'low-confidence', to: 'human', options: [] });
    ctx.runtime.bus.emit({ type: 'escalation.resolved', runId: 'live1', ts: new Date().toISOString(), escalationId: 'e2', resolution: 'approved', by: 'human' });
    await new Promise((r) => setTimeout(r, 150));
    expect(hook.hits).toHaveLength(3);
  });
});
