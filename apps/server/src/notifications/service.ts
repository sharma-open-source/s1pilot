import { repos, type Db } from '@s1pilot/db';
import { newId, type RunEvent } from '@s1pilot/domain';
import {
  deliverWithRetry,
  emailNotifier,
  isFailureEvent,
  slackNotifier,
  smtpTransport,
  teamsNotifier,
  webhookNotifier,
  type DeliveryOutcome,
  type FetchLike,
  type MailTransport,
  type NotificationEvent,
  type Notifier,
  type RetryOptions,
  type SmtpOptions,
} from '@s1pilot/integrations';
import type { FastifyBaseLogger } from 'fastify';

import type { ServerConfig } from '../config.js';
import { evaluateExitCriteria } from '../exit-criteria/evaluate.js';
import type { RunEventBus } from '../worker/event-bus.js';

import { appendDelivery, loadChannels, loadRules, type Channel, type Rule } from './store.js';

/** Time an attended escalation may wait before `approval.required` is sent. */
export const APPROVAL_WAIT_MS = 60_000;

/** Test hooks: fake fetch / SMTP transport, no-wait retries, shorter approval wait. */
export interface NotificationOverrides {
  fetch?: FetchLike;
  transport?: (o: SmtpOptions) => MailTransport;
  retry?: RetryOptions;
  approvalWaitMs?: number;
}
const overrides = new WeakMap<Db, NotificationOverrides>();

/** Registers overrides for a database (tests only). */
export function configureNotifications(db: Db, o: NotificationOverrides): void {
  overrides.set(db, o);
}

export interface NotifyDeps {
  db: Db;
  config: ServerConfig;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

/** Resolves an `env:NAME` reference, otherwise returns the literal. */
function resolveSecret(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!v.startsWith('env:')) return v;
  const value = process.env[v.slice(4)];
  if (!value) throw new Error(`Environment variable ${v.slice(4)} is not set`);
  return value;
}

/** Builds the notifier of a channel (secrets resolved now, never logged). */
export function buildNotifier(db: Db, channel: Channel): Notifier {
  const o = overrides.get(db) ?? {};
  const c = channel.config;
  const fetchOpt = o.fetch ? { fetch: o.fetch } : {};
  switch (c.kind) {
    case 'slack': {
      const webhookUrl = resolveSecret(c.webhookUrl);
      const botToken = resolveSecret(c.botToken);
      return slackNotifier({ ...(webhookUrl ? { webhookUrl } : {}), ...(botToken ? { botToken } : {}), ...(c.channel ? { channel: c.channel } : {}), ...fetchOpt });
    }
    case 'teams':
      return teamsNotifier({ webhookUrl: resolveSecret(c.webhookUrl) as string, ...fetchOpt });
    case 'webhook': {
      const secret = resolveSecret(c.secret);
      return webhookNotifier({ url: resolveSecret(c.url) as string, ...(secret ? { secret } : {}), ...fetchOpt });
    }
    case 'email': {
      const pass = resolveSecret(c.pass);
      const smtp: SmtpOptions = { host: c.host, port: c.port, secure: c.secure, ...(c.user ? { user: c.user } : {}), ...(pass ? { pass } : {}) };
      return emailNotifier({ transport: (o.transport ?? smtpTransport)(smtp), from: c.from, to: c.to });
    }
  }
}

/** Public base URL used in message links: `workspace.publicUrl` setting, else the server address. */
export async function publicBaseUrl(db: Db, config: ServerConfig): Promise<string> {
  const v = await repos.settings.get(db, 'workspace.publicUrl');
  if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace(/\/+$/, '');
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  return `http://${host}:${config.port}`;
}

/** True when `rule` subscribes to `event`. */
export function ruleMatches(rule: Rule, event: NotificationEvent, planId?: string): boolean {
  if (!rule.events.includes(event.type)) return false;
  if (rule.projectKey !== null && rule.projectKey !== event.projectKey) return false;
  if (rule.planId !== null && rule.planId !== planId) return false;
  if (rule.onlyOnFailure && !isFailureEvent(event)) return false;
  // Fires once, when the queue first exceeds the threshold.
  if (event.type === 'review.threshold' && event.pending !== rule.reviewThreshold + 1) return false;
  return true;
}

/** Sends `event` through `channel` with retries and writes the delivery log. */
export async function deliver(deps: NotifyDeps, channel: Channel, event: NotificationEvent): Promise<DeliveryOutcome> {
  const o = overrides.get(deps.db) ?? {};
  const outcome = await deliverWithRetry(() => buildNotifier(deps.db, channel).send(event), o.retry);
  await appendDelivery(deps.db, {
    id: newId(),
    at: new Date().toISOString(),
    channelId: channel.id,
    channelName: channel.name,
    event: event.type,
    ok: outcome.ok,
    attempts: outcome.attempts,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  if (!outcome.ok) deps.log.warn({ channel: channel.name, event: event.type, attempts: outcome.attempts, error: outcome.error }, 'notification delivery failed');
  return outcome;
}

/** Delivers `event` to every channel whose rules match. Never throws. */
export async function notify(deps: NotifyDeps, event: NotificationEvent, planId?: string): Promise<void> {
  try {
    const [rules, channels] = await Promise.all([loadRules(deps.db), loadChannels(deps.db)]);
    const targets = new Set(rules.filter((r) => ruleMatches(r, event, planId)).map((r) => r.channelId));
    await Promise.all(channels.filter((c) => targets.has(c.id)).map((c) => deliver(deps, c, event)));
  } catch (e) {
    deps.log.warn({ error: e instanceof Error ? e.message : String(e) }, 'notification dispatch failed');
  }
}

/** Event for a finished run, with its plan name and exit criteria. */
export async function runFinishedEvent(deps: NotifyDeps, runId: string): Promise<{ event: NotificationEvent; planId?: string } | undefined> {
  const run = await repos.runs.get(deps.db, runId);
  if (!run) return undefined;
  const project = await repos.projects.get(deps.db, run.projectId);
  if (!project) return undefined;
  const plan = run.planId ? await repos.plans.get(deps.db, run.planId) : undefined;
  const base = await publicBaseUrl(deps.db, deps.config);
  const ev = await evaluateExitCriteria(run, plan, deps.db);
  const met = ev.items.filter((i) => i.met).length;
  const runUrl = `${base}/p/${project.key}/runs/${run.id}`;
  return {
    event: {
      type: 'run.finished',
      projectKey: project.key,
      runId: run.id,
      ...(plan ? { planId: plan.id, planName: plan.name } : {}),
      status: run.status,
      summary: run.summary,
      ...(ev.items.length > 0 ? { exitCriteria: { met, total: ev.items.length, allMet: ev.met } } : {}),
      url: runUrl,
      liveUrl: `${runUrl}/live`,
    },
    ...(plan ? { planId: plan.id } : {}),
  };
}

/**
 * Wires bus events to notifications: `run.finished`, and `approval.required` when a human escalation waits longer
 * than {@link APPROVAL_WAIT_MS}. Returns the unsubscribe function.
 */
export function attachNotifications(deps: NotifyDeps, bus: RunEventBus): () => void {
  const waiting = new Map<string, NodeJS.Timeout>();
  const clearRun = (runId: string): void => {
    for (const [k, t] of waiting) if (k.startsWith(`${runId}:`)) { clearTimeout(t); waiting.delete(k); }
  };
  const unsubscribe = bus.subscribe((e: RunEvent) => {
    if (e.type === 'run.finished') {
      clearRun(e.runId);
      void runFinishedEvent(deps, e.runId).then((r) => (r ? notify(deps, r.event, r.planId) : undefined));
    } else if (e.type === 'escalation.needed' && e.to === 'human') {
      const key = `${e.runId}:${e.escalationId}`;
      const waitMs = overrides.get(deps.db)?.approvalWaitMs ?? APPROVAL_WAIT_MS;
      const startedAt = Date.now();
      waiting.set(
        key,
        setTimeout(() => {
          waiting.delete(key);
          void (async () => {
            const run = await repos.runs.get(deps.db, e.runId);
            const project = run ? await repos.projects.get(deps.db, run.projectId) : undefined;
            if (!run || !project) return;
            const base = await publicBaseUrl(deps.db, deps.config);
            await notify(
              deps,
              {
                type: 'approval.required',
                projectKey: project.key,
                runId: run.id,
                ...(run.planId ? { planId: run.planId } : {}),
                question: e.question ?? e.detail ?? 'A step needs a decision',
                waitingSec: Math.round((Date.now() - startedAt) / 1000),
                url: `${base}/p/${project.key}/runs/${run.id}/live`,
              },
              run.planId,
            );
          })();
        }, waitMs),
      );
      waiting.get(key)?.unref();
    } else if (e.type === 'escalation.resolved') {
      const key = `${e.runId}:${e.escalationId}`;
      const t = waiting.get(key);
      if (t) clearTimeout(t);
      waiting.delete(key);
    }
  });
  return () => {
    unsubscribe();
    for (const t of waiting.values()) clearTimeout(t);
    waiting.clear();
  };
}

/** Sends `review.threshold` when the pending queue of a project just crossed a rule's threshold. */
export async function notifyReviewQueue(deps: NotifyDeps, projectId: string): Promise<void> {
  const project = await repos.projects.get(deps.db, projectId);
  if (!project) return;
  const pending = (await repos.reviews.list(deps.db, { projectId, status: 'pending' })).length;
  const rules = (await loadRules(deps.db)).filter((r) => r.events.includes('review.threshold'));
  const thresholds = [...new Set(rules.map((r) => r.reviewThreshold))].filter((t) => pending === t + 1);
  if (thresholds.length === 0) return;
  const base = await publicBaseUrl(deps.db, deps.config);
  for (const threshold of thresholds) {
    await notify(deps, { type: 'review.threshold', projectKey: project.key, pending, threshold, url: `${base}/p/${project.key}/review` });
  }
}
