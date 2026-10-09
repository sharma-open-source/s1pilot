import { createHmac, timingSafeEqual } from 'node:crypto';

import nodemailer from 'nodemailer';

/** Notification event names (S-065). */
export const NOTIFICATION_EVENTS = ['run.finished', 'approval.required', 'review.threshold', 'defect.created'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];

/** Fields shared by every event. */
export interface NotificationBase {
  projectKey: string;
  /** Link to the UI page the message points at (report, live view, review queue, defect). */
  url: string;
}

export interface RunFinishedEvent extends NotificationBase {
  type: 'run.finished';
  runId: string;
  planId?: string;
  planName?: string;
  status: string;
  summary: { passed: number; failed: number; blocked: number; skipped: number; flaky: number; needsReview: number };
  exitCriteria?: { met: number; total: number; allMet: boolean };
  /** Live view link. */
  liveUrl?: string;
}
export interface ApprovalRequiredEvent extends NotificationBase {
  type: 'approval.required';
  runId: string;
  planId?: string;
  question: string;
  waitingSec: number;
}
export interface ReviewThresholdEvent extends NotificationBase {
  type: 'review.threshold';
  pending: number;
  threshold: number;
}
export interface DefectCreatedEvent extends NotificationBase {
  type: 'defect.created';
  defectKey: string;
  title: string;
  severity: string;
}
export type NotificationEvent = RunFinishedEvent | ApprovalRequiredEvent | ReviewThresholdEvent | DefectCreatedEvent;

/** True when the event reports a failing outcome (used by the rules' "only on failure" toggle). */
export function isFailureEvent(e: NotificationEvent): boolean {
  if (e.type !== 'run.finished') return true;
  return e.status !== 'passed' && e.status !== 'cancelled';
}

/** Headline and detail lines shared by all text-based notifiers. */
export function describeEvent(e: NotificationEvent): { title: string; lines: string[]; linkLabel: string } {
  switch (e.type) {
    case 'run.finished': {
      const s = e.summary;
      const lines = [`${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky, ${s.blocked} blocked, ${s.needsReview} need review, ${s.skipped} skipped`];
      if (e.exitCriteria) lines.push(`Exit criteria: ${e.exitCriteria.met} of ${e.exitCriteria.total} met`);
      return { title: `Run ${e.status}: ${e.planName ?? e.runId} (${e.projectKey})`, lines, linkLabel: 'Open report' };
    }
    case 'approval.required':
      return { title: `Approval needed in ${e.projectKey}`, lines: [e.question, `Waiting for ${e.waitingSec} s`], linkLabel: 'Open live view' };
    case 'review.threshold':
      return { title: `Review queue has ${e.pending} pending items (${e.projectKey})`, lines: [`Threshold is ${e.threshold}`], linkLabel: 'Open review queue' };
    case 'defect.created':
      return { title: `Defect ${e.defectKey} created (${e.severity})`, lines: [e.title], linkLabel: 'Open defect' };
  }
}

/** A delivery target. `send` throws on failure so callers can retry. */
export interface Notifier {
  readonly kind: 'slack' | 'teams' | 'email' | 'webhook';
  send(event: NotificationEvent): Promise<void>;
}

/** Minimal fetch used by HTTP notifiers (the global fetch is the default). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

async function postJson(fetchFn: FetchLike, url: string, body: unknown, extra: Record<string, string> = {}): Promise<void> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Slack Block Kit message (summary section + link buttons). */
export function slackMessage(e: NotificationEvent): Record<string, unknown> {
  const d = describeEvent(e);
  return {
    text: d.title,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: d.title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: d.lines.join('\n') } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: d.linkLabel }, url: e.url },
          ...(e.type === 'run.finished' && e.liveUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Open live view' }, url: e.liveUrl }] : []),
        ],
      },
    ],
  };
}

/** Slack incoming webhook (or `chat.postMessage` with a bot token and channel). */
export function slackNotifier(opts: { webhookUrl?: string; botToken?: string; channel?: string; fetch?: FetchLike }): Notifier {
  const f = opts.fetch ?? defaultFetch;
  return {
    kind: 'slack',
    async send(event) {
      const msg = slackMessage(event);
      if (opts.webhookUrl) return postJson(f, opts.webhookUrl, msg);
      if (opts.botToken && opts.channel) {
        return postJson(f, 'https://slack.com/api/chat.postMessage', { ...msg, channel: opts.channel }, { authorization: `Bearer ${opts.botToken}` });
      }
      throw new Error('Slack needs a webhook URL or a bot token with a channel');
    },
  };
}

/** Microsoft Teams Adaptive Card payload. */
export function teamsMessage(e: NotificationEvent): Record<string, unknown> {
  const d = describeEvent(e);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', wrap: true, text: d.title },
            ...d.lines.map((text) => ({ type: 'TextBlock', wrap: true, text })),
          ],
          actions: [{ type: 'Action.OpenUrl', title: d.linkLabel, url: e.url }],
        },
      },
    ],
  };
}

/** Teams incoming webhook. */
export function teamsNotifier(opts: { webhookUrl: string; fetch?: FetchLike }): Notifier {
  const f = opts.fetch ?? defaultFetch;
  return { kind: 'teams', send: (event) => postJson(f, opts.webhookUrl, teamsMessage(event)) };
}

/** Header names of outbound webhooks. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-s1pilot-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-s1pilot-timestamp';

/** `sha256=<hex>` HMAC of `<timestamp>.<body>`. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Verifies a webhook signature in constant time. Receivers should also check the timestamp age. */
export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Outbound webhook: JSON `{ event, sentAt, data }`, signed when a secret is set. */
export function webhookNotifier(opts: { url: string; secret?: string; fetch?: FetchLike; now?: () => Date }): Notifier {
  const f = opts.fetch ?? defaultFetch;
  const now = opts.now ?? (() => new Date());
  return {
    kind: 'webhook',
    async send(event) {
      const timestamp = now().toISOString();
      const body = JSON.stringify({ event: event.type, sentAt: timestamp, data: event });
      const headers: Record<string, string> = { [WEBHOOK_TIMESTAMP_HEADER]: timestamp };
      if (opts.secret) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhook(opts.secret, timestamp, body);
      await postJson(f, opts.url, body, headers);
    },
  };
}

/** The part of a nodemailer transport the email notifier needs (tests inject a fake). */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
}

/** Real SMTP transport via nodemailer. */
export function smtpTransport(o: SmtpOptions): MailTransport {
  return nodemailer.createTransport({
    host: o.host,
    port: o.port,
    secure: o.secure ?? false,
    ...(o.user ? { auth: { user: o.user, pass: o.pass ?? '' } } : {}),
  });
}

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** Email notifier (SMTP). */
export function emailNotifier(opts: { transport: MailTransport; from: string; to: string[] }): Notifier {
  return {
    kind: 'email',
    async send(event) {
      const d = describeEvent(event);
      await opts.transport.sendMail({
        from: opts.from,
        to: opts.to.join(', '),
        subject: d.title,
        text: `${d.lines.join('\n')}\n\n${d.linkLabel}: ${event.url}`,
        html: `<h2>${escapeHtml(d.title)}</h2>${d.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p><a href="${escapeHtml(event.url)}">${escapeHtml(d.linkLabel)}</a></p>`,
      });
    },
  };
}

export interface RetryOptions {
  /** Retries after the first attempt (default 3, so 4 attempts in total). */
  retries?: number;
  /** Delay before retry n (1-based); default 500 ms doubling. */
  backoffMs?: (retry: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryOutcome {
  ok: boolean;
  /** Attempts made (1 = delivered first time). */
  attempts: number;
  error?: string;
}

/** Runs `send`, retrying with exponential backoff; never throws. */
export async function deliverWithRetry(send: () => Promise<void>, opts: RetryOptions = {}): Promise<DeliveryOutcome> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? ((n: number) => 500 * 2 ** (n - 1));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let error = '';
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await send();
      return { ok: true, attempts: attempt };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (attempt <= retries) await sleep(backoff(attempt));
    }
  }
  return { ok: false, attempts: retries + 1, error };
}
