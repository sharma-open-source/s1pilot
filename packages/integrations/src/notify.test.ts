import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { deliverWithRetry, emailNotifier, slackNotifier, teamsNotifier, verifyWebhookSignature, webhookNotifier, type NotificationEvent } from './notify.js';

const event: NotificationEvent = {
  type: 'run.finished',
  projectKey: 'SHOP',
  runId: 'run1',
  planName: 'Smoke',
  status: 'failed',
  summary: { passed: 3, failed: 1, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 },
  exitCriteria: { met: 1, total: 2, allMet: false },
  url: 'http://localhost:4300/p/SHOP/runs/run1',
};

interface Hit {
  headers: IncomingMessage['headers'];
  body: string;
}
const servers: Server[] = [];
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
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('notifiers', () => {
  it('Slack posts Block Kit with a report button', async () => {
    const { url, hits } = await fake();
    await slackNotifier({ webhookUrl: url }).send(event);
    const msg = JSON.parse(hits[0]?.body ?? '{}') as { blocks: Array<{ type: string; elements?: Array<{ url: string }> }> };
    expect(msg.blocks.map((b) => b.type)).toEqual(['header', 'section', 'actions']);
    expect(msg.blocks[2]?.elements?.[0]?.url).toBe(event.url);
    expect(JSON.stringify(msg)).toContain('3 passed, 1 failed');
  });

  it('Teams posts an Adaptive Card', async () => {
    const { url, hits } = await fake();
    await teamsNotifier({ webhookUrl: url }).send(event);
    const msg = JSON.parse(hits[0]?.body ?? '{}') as { attachments: Array<{ contentType: string; content: { actions: Array<{ url: string }> } }> };
    expect(msg.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(msg.attachments[0]?.content.actions[0]?.url).toBe(event.url);
  });

  it('webhook signature verifies with the shared secret only', async () => {
    const { url, hits } = await fake();
    await webhookNotifier({ url, secret: 's3cret' }).send(event);
    const h = hits[0] as Hit;
    const ts = h.headers['x-s1pilot-timestamp'] as string;
    const sig = h.headers['x-s1pilot-signature'] as string;
    expect(verifyWebhookSignature('s3cret', ts, h.body, sig)).toBe(true);
    expect(verifyWebhookSignature('other', ts, h.body, sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', ts, `${h.body} `, sig)).toBe(false);
    expect((JSON.parse(h.body) as { event: string }).event).toBe('run.finished');
  });

  it('throws on a non-2xx response', async () => {
    const { url } = await fake(500);
    await expect(slackNotifier({ webhookUrl: url }).send(event)).rejects.toThrow('HTTP 500');
  });

  it('email sends subject and link through the transport', async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const transport = {
      sendMail: (m: { to: string; subject: string; text: string }) => {
        sent.push(m);
        return Promise.resolve();
      },
    };
    await emailNotifier({ transport: transport as never, from: 'a@x.io', to: ['b@x.io', 'c@x.io'] }).send(event);
    expect(sent[0]?.to).toBe('b@x.io, c@x.io');
    expect(sent[0]?.subject).toContain('Run failed');
    expect(sent[0]?.text).toContain(event.url);
  });
});

describe('deliverWithRetry', () => {
  it('retries 3 times then reports failure', async () => {
    const { url, hits } = await fake(500);
    const delays: number[] = [];
    const out = await deliverWithRetry(() => slackNotifier({ webhookUrl: url }).send(event), {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(out).toMatchObject({ ok: false, attempts: 4 });
    expect(hits).toHaveLength(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it('stops after the first success', async () => {
    let n = 0;
    const out = await deliverWithRetry(
      () => (++n < 2 ? Promise.reject(new Error('x')) : Promise.resolve()),
      { sleep: () => Promise.resolve() },
    );
    expect(out).toEqual({ ok: true, attempts: 2 });
  });
});
