import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { buildApp, loadConfig } from '@s1pilot/server';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../program.js';

import { upsertPrComment } from './github.js';
import { PR_COMMENT_MARKER, renderPrComment, type CiSummary } from './summary.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SUMMARY: CiSummary = {
  title: 'Smoke',
  environment: 'staging',
  outcome: 'failed',
  exitCode: 1,
  totals: { passed: 8, failed: 1, blocked: 0, flaky: 1, needsReview: 2, skipped: 0 },
  criteria: {
    met: 1,
    total: 2,
    allMet: false,
    items: [
      { label: '>= 100% of P0 passed', met: false, actual: '50%' },
      { label: 'Review queue empty', met: true },
    ],
  },
  reportUrl: 'https://s1p.example/p/SHOP/runs/abc',
  buildRef: 'abc1234',
  branch: 'feature/x',
};

describe('PR comment template', () => {
  it('renders the summary table, criteria and report link', () => {
    expect(renderPrComment(SUMMARY)).toMatchInlineSnapshot(`
      "<!-- s1pilot-run-summary -->
      ### s1-pilot: Failed

      **Smoke** on \`staging\` · build \`abc1234\` · branch \`feature/x\`

      | Result | Cases |
      | --- | ---: |
      | Passed | 8 |
      | Failed | 1 |
      | Blocked | 0 |
      | Flaky | 1 |
      | Needs review | 2 |
      | Skipped | 0 |
      | **Total** | **12** |

      Exit criteria: 1 of 2 met

      - Not met: >= 100% of P0 passed (50%)
      - Met: Review queue empty

      [Open the full report](https://s1p.example/p/SHOP/runs/abc)
      "
    `);
  });

  it('escapes table-breaking characters in titles', () => {
    const body = renderPrComment({ ...SUMMARY, title: 'a | b', criteria: null });
    expect(body).toContain('**a \\| b**');
    expect(body).not.toContain('Exit criteria');
  });
});

/** Fake GitHub issues-comments API. */
function fakeGithub(initial: Array<{ id: number; body: string }> = []) {
  const comments = [...initial];
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer gh-secret');
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (method === 'GET' && url.pathname === '/repos/acme/shop/issues/7/comments') return json(comments);
    if (method === 'POST' && url.pathname === '/repos/acme/shop/issues/7/comments') {
      const c = { id: 100 + comments.length, body: (JSON.parse(String(init?.body)) as { body: string }).body };
      comments.push(c);
      return json(c, 201);
    }
    const m = /^\/repos\/acme\/shop\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (method === 'PATCH' && m) {
      const c = comments.find((x) => x.id === Number(m[1]));
      if (!c) return json({}, 404);
      c.body = (JSON.parse(String(init?.body)) as { body: string }).body;
      return json(c);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, comments, calls };
}

describe('upsertPrComment', () => {
  const target = { repo: 'acme/shop', pullNumber: 7, token: 'gh-secret' };

  it('creates the comment once and updates it on the next run', async () => {
    const gh = fakeGithub([{ id: 1, body: 'unrelated' }]);
    const first = await upsertPrComment(target, renderPrComment(SUMMARY), gh.fetchImpl);
    expect(first.created).toBe(true);
    const second = await upsertPrComment(target, renderPrComment({ ...SUMMARY, outcome: 'passed' }), gh.fetchImpl);
    expect(second).toEqual({ id: first.id, created: false });
    expect(gh.comments).toHaveLength(2);
    expect(gh.comments[1]?.body).toContain(PR_COMMENT_MARKER);
    expect(gh.comments[1]?.body).toContain('s1-pilot: Passed');
    expect(gh.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('is driven by the ci-comment command from the GitHub environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's1p-ci-'));
    try {
      const summaryFile = join(dir, 'ci-summary.json');
      writeFileSync(summaryFile, JSON.stringify(SUMMARY));
      const eventFile = join(dir, 'event.json');
      writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 7 } }));
      const gh = fakeGithub();
      const out: string[] = [];
      const program = buildProgram({
        stdout: (t) => out.push(t),
        stderr: (t) => out.push(t),
        exitOverride: true,
        fetch: gh.fetchImpl,
        env: { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'gh-secret', GITHUB_EVENT_PATH: eventFile, GITHUB_API_URL: 'https://api.github.test' },
      });
      await program.parseAsync(['node', 's1pilot', 'ci-comment', '--summary', summaryFile]);
      expect(out.join('')).toContain('Posted PR comment on acme/shop#7');
      expect(gh.comments[0]?.body).toContain('**Smoke**');

      // Outside a pull request nothing is posted.
      const quiet: string[] = [];
      await buildProgram({ stdout: (t) => quiet.push(t), exitOverride: true, fetch: gh.fetchImpl, env: {} }).parseAsync(['node', 's1pilot', 'ci-comment', '--summary', summaryFile]);
      expect(quiet.join('')).toContain('skipping');
      expect(gh.comments).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('s1pilot run --plan --server', () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  async function startServer(): Promise<{ app: FastifyInstance; db: Db; url: string; token: string; out: string }> {
    const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
    const dir = mkdtempSync(join(tmpdir(), 's1p-ci-srv-'));
    dirs.push(dir);
    const config = loadConfig({ dataDir: join(dir, '.s1pilot'), logLevel: 'silent' }, {});
    const app = await buildApp(config, { db, workers: 0, dev: true, scheduler: false });
    closers.push(async () => {
      await app.close();
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const trpc = async (path: string, body: unknown, token?: string): Promise<{ result: { data: Record<string, unknown> } }> => {
      const res = await fetch(`${url}/trpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      return (await res.json()) as { result: { data: Record<string, unknown> } };
    };
    const { result } = await trpc('tokens.create', { name: 'ci', scopes: ['runs:write', 'results:read'] });
    return { app, db, url, token: result.data['token'] as string, out: join(dir, 'out') };
  }

  /** Seeds project, environment, one P0 case and a plan with a P0 exit criterion; returns a function that finishes the CI run. */
  async function seed(srv: { db: Db; url: string }, p0Verdict: 'passed' | 'failed', finish = true) {
    const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(`${srv.url}/trpc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json()) as { result?: { data: Record<string, unknown> }; error?: { message: string } };
      if (!json.result) throw new Error(`${path}: ${json.error?.message ?? res.status}`);
      return json.result.data;
    };
    const project = await call('projects.create', { name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    const env = await call('environments.create', { projectKey: 'SHOP', name: 'staging', baseUrl: 'http://a.test' });
    const testCase = await call('cases.create', { projectKey: 'SHOP', title: 'Checkout', priority: 'P0', steps: [{ action: 'Open' }] });
    await call('plans.create', {
      projectKey: 'SHOP',
      name: 'Smoke',
      selection: { kind: 'list', caseIds: [testCase['id']] },
      matrix: [{ environmentId: env['id'], browser: 'chromium' }],
      exitCriteria: [{ kind: 'p0-passed', params: { percent: 100 } }],
    });
    if (!finish) return undefined;
    // No workers run in this test: act as the worker once the CLI has queued the run (started after seeding).
    return () => (async () => {
      for (let i = 0; i < 200; i += 1) {
        const [run] = await repos.runs.listByProject(srv.db, project['id'] as string);
        if (run) {
          await repos.results.createCase(srv.db, { id: 'cr1', runId: run.id, caseId: testCase['id'] as string, caseVersion: 1, environmentId: env['id'] as string, verdict: p0Verdict, durationMs: 5, mode: 'explore', browser: 'chromium' });
          await repos.runs.update(srv.db, run.id, {
            status: p0Verdict === 'passed' ? 'passed' : 'failed',
            finishedAt: new Date().toISOString(),
            summary: { passed: p0Verdict === 'passed' ? 1 : 0, failed: p0Verdict === 'failed' ? 1 : 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 },
          });
          return run;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('run was never queued');
    })();
  }

  async function runCli(srv: { url: string; token: string; out: string }, extra: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    let code = -1;
    const program = buildProgram({
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      setExitCode: (c) => {
        code = c;
      },
      exitOverride: true,
      env: { GITHUB_ACTIONS: 'true' },
    });
    await program.parseAsync([
      'node', 's1pilot', 'run', '--plan', 'smoke', '--env', 'staging', '--server', srv.url, '--project-key', 'SHOP',
      '--token', srv.token, '--reporter', 'junit,json,html', '--out', srv.out, '--poll-interval', '50',
      '--commit', 'abc1234', '--branch', 'main', ...extra,
    ]);
    return { code, out: out.join(''), err: err.join('') };
  }

  it('exits 1 when the exit criteria are unmet, downloads the reports and records a ci run', async () => {
    const srv = await startServer();
    const startFinisher = await seed(srv, 'failed');
    if (!startFinisher) throw new Error('seed');
    const finished = startFinisher();
    const r = await runCli(srv);
    const run = await finished;
    expect(r.code).toBe(1);
    expect(r.out).toContain('Exit criteria: 0 of 1 met');
    expect(r.out).toContain(`/p/SHOP/runs/${run.id}`);
    const stored = await repos.runs.get(srv.db, run.id);
    expect(stored).toMatchObject({ trigger: 'ci', buildRef: 'abc1234' });
    expect(readFileSync(join(srv.out, 'junit.xml'), 'utf8')).toContain('<testsuite');
    expect(readFileSync(join(srv.out, 'report.html'), 'utf8')).toContain('<html');
    const summary = JSON.parse(readFileSync(join(srv.out, 'ci-summary.json'), 'utf8')) as CiSummary;
    expect(summary).toMatchObject({ outcome: 'failed', exitCode: 1, branch: 'main', title: 'Smoke' });
    expect(JSON.stringify(summary)).not.toContain(srv.token);
    expect(JSON.stringify(r)).not.toContain(srv.token);
  });

  it('exits 0 when the criteria are met and marks GitHub as connected', async () => {
    const srv = await startServer();
    const startFinisher = await seed(srv, 'passed');
    const finished = startFinisher?.();
    const r = await runCli(srv);
    await finished;
    expect(r.code).toBe(0);
    expect(r.out).toContain('Exit criteria: 1 of 1 met');
    const res = await fetch(`${srv.url}/trpc/tokens.ciUsage`);
    const usage = ((await res.json()) as { result: { data: Record<string, { connected: boolean; lastUsedAt: string | null }> } }).result.data;
    expect(usage['github']?.connected).toBe(true);
    expect(usage['gitlab']?.connected).toBe(false);
  });

  it('reports configuration problems with exit code 3', async () => {
    const srv = await startServer();
    await seed(srv, 'passed', false);
    expect((await runCli({ ...srv, token: 's1p_00000000_' + '0'.repeat(48) })).code).toBe(3);
    const missing = await runCli(srv, ['--plan', 'Nope']);
    expect(missing.code).toBe(3);
    expect(missing.err).toContain('No plan named "Nope"');
  });
});
