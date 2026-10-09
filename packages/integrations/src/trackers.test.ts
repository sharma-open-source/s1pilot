import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createTracker, type TrackerAttachment, type TrackerDefect } from './index.js';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
type Handler = (req: Recorded) => { status?: number; json?: unknown; text?: string };

const servers: Server[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
});

/** Local fake tracker API: records every request and answers with the canned fixture of `handler`. */
async function fake(handler: Handler): Promise<{ url: string; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('latin1') };
      calls.push(rec);
      const out = handler(rec);
      res.statusCode = out.status ?? 200;
      if (out.json !== undefined) res.setHeader('content-type', 'application/json');
      res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? ''));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const defect: TrackerDefect = {
  key: 'DEF-3',
  title: 'Cart badge shows 2 after adding one item',
  severity: 'S2',
  stepsToReproduce: ['Open the shop', 'Add "Classic Tee" to the cart'],
  expected: 'Badge shows 1',
  actual: 'Badge shows 2',
  environment: 'staging',
  browser: 'chromium',
  buildRef: 'abc1234',
  sourceLabel: 'SHOP-TC-42',
};
const shot: TrackerAttachment = { filename: 'step-02.png', contentType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) };

describe('Jira tracker', () => {
  it('creates an issue with ADF body and uploads the screenshot', async () => {
    const api = await fake((r) => {
      if (r.url === '/rest/api/3/issue') return { status: 201, json: { id: '10001', key: 'SHOP-17' } };
      if (r.url.endsWith('/attachments')) return { json: [{ id: '1' }] };
      return { status: 404 };
    });
    const jira = createTracker('jira', { baseUrl: api.url, email: 'qa@acme.test', token: 'jira-secret-token' }, { jiraProject: 'SHOP' });
    const issue = await jira.createIssue(defect, [shot]);
    expect(issue).toEqual({ id: 'SHOP-17', url: `${api.url}/browse/SHOP-17` });

    const create = api.calls[0];
    expect(create?.headers.authorization).toBe(`Basic ${Buffer.from('qa@acme.test:jira-secret-token').toString('base64')}`);
    const fields = (JSON.parse(create?.body ?? '{}') as { fields: Record<string, unknown> }).fields;
    expect(fields).toMatchObject({ project: { key: 'SHOP' }, issuetype: { name: 'Bug' }, summary: defect.title });
    const adf = JSON.stringify(fields['description']);
    for (const text of ['Open the shop', 'Badge shows 1', 'Badge shows 2', 'Environment: staging', 'Build: abc1234', 'step-02.png']) expect(adf).toContain(text);

    const upload = api.calls[1];
    expect(upload?.url).toBe('/rest/api/3/issue/SHOP-17/attachments');
    expect(upload?.headers['x-atlassian-token']).toBe('no-check');
    expect(upload?.body).toContain('filename="step-02.png"');
  });

  it('reads the status and maps categories', async () => {
    const api = await fake(() => ({ json: { fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } }));
    const jira = createTracker('jira', { baseUrl: api.url, email: 'a@b.c', token: 't' }, { jiraProject: 'SHOP' });
    const status = await jira.getStatus('SHOP-17');
    expect(status).toEqual({ name: 'Done', state: 'done' });
    expect(jira.mapStatus(status)).toBe('fixed');
    expect(jira.mapStatus({ name: 'In Progress', state: 'indeterminate' })).toBe('in-progress');
    expect(jira.mapStatus({ name: 'To Do', state: 'new' })).toBe('open');
  });

  it('tests the connection without leaking the token', async () => {
    const bad = await fake(() => ({ status: 401, text: 'unauthorized' }));
    const result = await createTracker('jira', { baseUrl: bad.url, email: 'a@b.c', token: 'jira-secret-token' }).testConnection();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('401');
    expect(result.detail).not.toContain('jira-secret-token');
    const good = await fake((r) => (r.url === '/rest/api/3/myself' ? { json: { displayName: 'Quinn QA' } } : { json: { key: 'SHOP' } }));
    expect(await createTracker('jira', { baseUrl: good.url, email: 'a@b.c', token: 't' }, { jiraProject: 'SHOP' }).testConnection()).toEqual({
      ok: true,
      detail: 'Signed in as Quinn QA',
    });
  });

  it('posts a comment', async () => {
    const api = await fake(() => ({ status: 201, json: {} }));
    await createTracker('jira', { baseUrl: api.url, email: 'a@b.c', token: 't' }).addComment('SHOP-17', 'Re-test passed');
    expect(api.calls[0]?.url).toBe('/rest/api/3/issue/SHOP-17/comment');
    expect(api.calls[0]?.body).toContain('Re-test passed');
  });
});

describe('GitHub tracker', () => {
  it('creates an issue with labels and a markdown body', async () => {
    const api = await fake(() => ({ status: 201, json: { number: 9, html_url: 'https://github.com/acme/shop/issues/9' } }));
    const gh = createTracker('github', { baseUrl: api.url, token: 'ghp_secret' }, { githubRepo: 'acme/shop', githubLabels: ['qa'] });
    const issue = await gh.createIssue(defect, [shot]);
    expect(issue).toEqual({ id: '9', url: 'https://github.com/acme/shop/issues/9' });
    const call = api.calls[0];
    expect(call?.url).toBe('/repos/acme/shop/issues');
    expect(call?.headers.authorization).toBe('Bearer ghp_secret');
    const body = JSON.parse(call?.body ?? '{}') as { title: string; body: string; labels: string[] };
    expect(body.labels).toEqual(['s1pilot', 'bug', 'severity-S2', 'qa']);
    expect(body.body).toContain('1. Open the shop');
    expect(body.body).toContain('Badge shows 1');
    expect(body.body).toContain('step-02.png');
  });

  it('maps open / closed / not planned', async () => {
    const api = await fake((r) => ({ json: r.url.endsWith('/1') ? { state: 'closed', state_reason: 'completed' } : { state: 'closed', state_reason: 'not_planned' } }));
    const gh = createTracker('github', { baseUrl: api.url, token: 't' }, { githubRepo: 'acme/shop' });
    expect(gh.mapStatus(await gh.getStatus('1'))).toBe('fixed');
    expect(gh.mapStatus(await gh.getStatus('2'))).toBe('closed');
    expect(gh.mapStatus({ name: 'open', state: 'open' })).toBe('open');
  });

  it('rejects a malformed repository and tests the connection', async () => {
    const api = await fake((r) => ({ json: r.url === '/user' ? { login: 'quinn' } : { full_name: 'acme/shop' } }));
    await expect(createTracker('github', { baseUrl: api.url, token: 't' }, { githubRepo: 'nope' }).createIssue(defect, [])).rejects.toMatchObject({ code: 'TRACKER_CONFIG' });
    expect((await createTracker('github', { baseUrl: api.url, token: 't' }, { githubRepo: 'acme/shop' }).testConnection()).detail).toBe('Signed in as quinn');
    await createTracker('github', { baseUrl: api.url, token: 't' }, { githubRepo: 'acme/shop' }).addComment('9', 'hi');
    expect(api.calls.at(-1)?.url).toBe('/repos/acme/shop/issues/9/comments');
  });
});

describe('Linear tracker', () => {
  it('uploads the screenshot, then creates the issue with a team and priority', async () => {
    let origin = '';
    const api = await fake((r) => {
      if (r.url === '/upload/1') return { text: '' };
      const q = (JSON.parse(r.body) as { query: string }).query;
      if (q.includes('fileUpload')) {
        return { json: { data: { fileUpload: { uploadFile: { uploadUrl: `${origin}/upload/1`, assetUrl: 'https://uploads.linear.app/a/step-02.png', headers: [{ key: 'x-goog-meta', value: 'v' }] } } } } };
      }
      if (q.includes('issueCreate')) return { json: { data: { issueCreate: { success: true, issue: { identifier: 'SHP-4', url: 'https://linear.app/acme/issue/SHP-4' } } } } };
      return { status: 400 };
    });
    origin = api.url;
    const linear = createTracker('linear', { baseUrl: `${api.url}/graphql`, token: 'lin_api_secret' }, { linearTeamId: 'team-1' });
    const issue = await linear.createIssue(defect, [shot]);
    expect(issue).toEqual({ id: 'SHP-4', url: 'https://linear.app/acme/issue/SHP-4' });
    expect(api.calls.map((c) => c.method + ' ' + c.url)).toEqual(['POST /graphql', 'PUT /upload/1', 'POST /graphql']);
    expect(api.calls[0]?.headers.authorization).toBe('lin_api_secret');
    expect(api.calls[1]?.headers['x-goog-meta']).toBe('v');
    const input = (JSON.parse(api.calls[2]?.body ?? '{}') as { variables: { input: { teamId: string; priority: number; description: string } } }).variables.input;
    expect(input).toMatchObject({ teamId: 'team-1', priority: 2 });
    expect(input.description).toContain('Badge shows 2');
    expect(input.description).toContain('![step-02.png](https://uploads.linear.app/a/step-02.png)');
  });

  it('maps state types and surfaces GraphQL errors', async () => {
    const api = await fake((r) => {
      const q = (JSON.parse(r.body) as { query: string }).query;
      if (q.includes('state')) return { json: { data: { issue: { state: { name: 'Done', type: 'completed' } } } } };
      return { json: { errors: [{ message: 'Authentication required' }] } };
    });
    const linear = createTracker('linear', { baseUrl: api.url, token: 't' }, { linearTeamId: 'team-1' });
    expect(linear.mapStatus(await linear.getStatus('SHP-4'))).toBe('fixed');
    expect(linear.mapStatus({ name: 'Canceled', state: 'canceled' })).toBe('closed');
    expect(linear.mapStatus({ name: 'In Progress', state: 'started' })).toBe('in-progress');
    expect(linear.mapStatus({ name: 'Backlog', state: 'backlog' })).toBe('open');
    const result = await linear.testConnection();
    expect(result).toEqual({ ok: false, detail: expect.stringContaining('Authentication required') });
  });
});

describe('createTracker', () => {
  it('requires Jira site and email', () => {
    expect(() => createTracker('jira', { token: 't' })).toThrow(/site URL/);
    expect(() => createTracker('jira', { baseUrl: 'http://x', token: 't' })).toThrow(/email/);
  });
});
