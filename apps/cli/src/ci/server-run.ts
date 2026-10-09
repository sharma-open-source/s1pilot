import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { S1PilotError } from '@s1pilot/domain';
import { REPORTER_FILES, parseReporterList } from '@s1pilot/reporters';
import { findProjectRoot, loadProjectFile } from '@s1pilot/sync';

import { ConfigError, EXIT_FAILED, EXIT_NEEDS_REVIEW, EXIT_PASSED, type RunDeps } from '../run.js';

import type { CiSummary } from './summary.js';

/** Options of `s1pilot run --plan ... --server ...`. */
export interface ServerRunOptions {
  plan?: string;
  env?: string;
  server?: string;
  token?: string;
  /** Project key; defaults to the key in `.s1pilot/project.yaml` found from `--project` or the working directory. */
  projectKey?: string;
  project?: string;
  buildRef?: string;
  commit?: string;
  branch?: string;
  reporter?: string;
  out: string;
  /** Milliseconds between status polls (default 2000). */
  pollInterval?: number;
  /** Give up waiting after this many milliseconds (default one hour). */
  waitTimeout?: number;
}

/** Side effects of a server run, injectable for tests. */
export interface ServerRunDeps extends RunDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set(['finished', 'aborted', 'passed', 'failed', 'needs-review', 'cancelled', 'error']);

interface RunSummaryCounts {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  flaky: number;
  needsReview: number;
}

interface RemoteRun {
  id: string;
  status: string;
  buildRef?: string;
  summary: RunSummaryCounts;
  results: { id: string; key: string; verdict: string }[];
}

interface RemoteReport {
  projectKey: string;
  exitCriteria: NonNullable<CiSummary['criteria']> | null;
}

/** Which CI system is running us (sent to the server so the Integrations cards can show it as connected). */
export function detectCiProvider(env: NodeJS.ProcessEnv): 'github' | 'gitlab' | 'other' {
  if (env['GITHUB_ACTIONS']) return 'github';
  if (env['GITLAB_CI']) return 'gitlab';
  return 'other';
}

/** Process exit code for a finished remote run: exit criteria decide when the plan has any, else the case verdicts. */
export function exitCodeForRemote(status: string, summary: RunSummaryCounts, criteria: CiSummary['criteria']): number {
  if (status === 'cancelled' || status === 'aborted' || status === 'error') return EXIT_FAILED;
  if (criteria) return criteria.allMet ? EXIT_PASSED : EXIT_FAILED;
  if (summary.failed + summary.blocked + summary.flaky > 0) return EXIT_FAILED;
  if (summary.needsReview > 0) return EXIT_NEEDS_REVIEW;
  return EXIT_PASSED;
}

class ServerClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly provider: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'x-s1pilot-ci': this.provider, 'content-type': 'application/json' };
  }

  private async fail(res: Response, what: string): Promise<never> {
    if (res.status === 401) throw new ConfigError(`${what}: the server rejected the API token (unknown or revoked)`);
    if (res.status === 403) throw new ConfigError(`${what}: the API token lacks a required scope (needs runs:write and results:read)`);
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } } | { message?: string };
      const m = 'error' in body ? body.error?.message : (body as { message?: string }).message;
      if (m) message = m;
    } catch {
      // keep the status text
    }
    throw new ConfigError(`${what}: ${message}`);
  }

  async query<T>(path: string, input: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: this.headers() });
    if (!res.ok) await this.fail(res, path);
    return ((await res.json()) as { result: { data: T } }).result.data;
  }

  async mutate<T>(path: string, input: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/trpc/${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(input) });
    if (!res.ok) await this.fail(res, path);
    return ((await res.json()) as { result: { data: T } }).result.data;
  }

  async download(path: string): Promise<Buffer> {
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: this.headers() });
    if (!res.ok) await this.fail(res, path);
    return Buffer.from(await res.arrayBuffer());
  }
}

function resolveProjectKey(opts: ServerRunOptions): string {
  if (opts.projectKey) return opts.projectKey;
  const root = findProjectRoot(resolve(opts.project ?? '.'));
  if (root) return loadProjectFile(root).project.key;
  throw new ConfigError('Cannot tell which project to run: pass --project-key <KEY> or run inside a directory with .s1pilot/project.yaml');
}

/**
 * Runs a plan on an s1-pilot server (`trigger: ci`): creates the run, prints progress lines while polling, downloads
 * the requested reports into `--out`, writes `ci-summary.json` and returns the exit code (see `exitCodeForRemote`).
 * Configuration problems (missing token, unknown plan, rejected token) return 3.
 */
export async function executeServerRun(opts: ServerRunOptions, deps: ServerRunDeps): Promise<number> {
  const say = (line: string): void => deps.stdout(`${line}\n`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    if (!opts.plan) throw new ConfigError('--plan <name> is required with --server');
    if (!opts.server) throw new ConfigError('--server <url> is required');
    const token = opts.token ?? deps.env['S1PILOT_TOKEN'];
    if (!token) throw new ConfigError('No API token: pass --token or set S1PILOT_TOKEN (create one under Settings > API tokens)');
    let base: string;
    try {
      base = new URL(opts.server).toString().replace(/\/+$/, '');
    } catch {
      throw new ConfigError(`Invalid --server URL: ${opts.server}`);
    }
    let reporters: ReturnType<typeof parseReporterList> = [];
    try {
      reporters = opts.reporter ? parseReporterList(opts.reporter) : [];
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
    const projectKey = resolveProjectKey(opts);
    const client = new ServerClient(base, token, detectCiProvider(deps.env), deps.fetch ?? fetch);

    const plans = await client.query<{ id: string; name: string }[]>('plans.list', { projectKey });
    const plan = plans.find((p) => p.name.toLowerCase() === (opts.plan ?? '').toLowerCase());
    if (!plan) {
      throw new ConfigError(`No plan named "${opts.plan}" in project ${projectKey}${plans.length > 0 ? `; available: ${plans.map((p) => p.name).join(', ')}` : ''}`);
    }
    const created = await client.mutate<{ id: string }>('runs.create', {
      projectKey,
      planId: plan.id,
      trigger: 'ci',
      attended: false,
      ...(opts.env ? { environment: opts.env } : {}),
      ...(opts.buildRef ? { buildRef: opts.buildRef } : {}),
      ...(opts.commit ? { commit: opts.commit } : {}),
    });
    const reportUrl = `${base}/p/${projectKey}/runs/${created.id}`;
    say(`s1pilot run  plan "${plan.name}"${opts.env ? `  env ${opts.env}` : ''}  server ${base}`);
    say(`Run ${created.id} queued: ${reportUrl}`);

    const seen = new Set<string>();
    const deadline = Date.now() + (opts.waitTimeout ?? 3_600_000);
    let run: RemoteRun;
    for (;;) {
      run = await client.query<RemoteRun>('runs.get', created.id);
      for (const r of run.results) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          say(`  [${seen.size}] ${r.key} ${r.verdict}`);
        }
      }
      if (TERMINAL.has(run.status)) break;
      if (Date.now() > deadline) throw new ConfigError(`Timed out waiting for run ${created.id} (status ${run.status}); it keeps running on the server`);
      await sleep(opts.pollInterval ?? 2000);
    }

    const report = await client.query<RemoteReport>('runs.report', created.id);
    const s = run.summary;
    const exitCode = exitCodeForRemote(run.status, s, report.exitCriteria);
    const summary: CiSummary = {
      title: plan.name,
      environment: opts.env ?? '',
      outcome: run.status === 'error' || run.status === 'cancelled' || run.status === 'aborted' ? 'error' : exitCode === EXIT_PASSED ? 'passed' : exitCode === EXIT_NEEDS_REVIEW ? 'needs-review' : 'failed',
      exitCode,
      totals: { passed: s.passed, failed: s.failed, blocked: s.blocked, flaky: s.flaky, needsReview: s.needsReview, skipped: s.skipped },
      criteria: report.exitCriteria,
      reportUrl,
      ...(run.buildRef ? { buildRef: run.buildRef } : {}),
      ...(opts.branch ? { branch: opts.branch } : {}),
    };
    say('');
    say(`Cases: ${s.passed} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.flaky} flaky, ${s.needsReview} needs review, ${s.skipped} skipped`);
    if (report.exitCriteria) say(`Exit criteria: ${report.exitCriteria.met} of ${report.exitCriteria.total} met`);

    const outDir = resolve(opts.out);
    await mkdir(outDir, { recursive: true });
    for (const name of reporters) {
      const file = join(outDir, REPORTER_FILES[name]);
      await writeFile(file, await client.download(`/api/runs/${created.id}/export/${name}`));
      say(`Report: ${file}`);
    }
    await writeFile(join(outDir, 'ci-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    say(`Report link: ${reportUrl}`);
    return exitCode;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof S1PilotError) {
      deps.stderr(`error: ${error.message}\n`);
      return 3;
    }
    if (error instanceof TypeError) {
      deps.stderr(`error: cannot reach the server (${error.message})\n`);
      return 3;
    }
    throw error;
  }
}
