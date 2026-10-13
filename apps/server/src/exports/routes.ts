import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repos, type Db } from '@s1pilot/db';
import {
  RunReportSchema,
  type BrowserName,
  type CaseRunResult,
  type RunReport,
  type StepReport,
} from '@s1pilot/domain';
import { renderHtml, renderJson, renderJunit, renderSummaryHtml } from '@s1pilot/reporters';
import type { FastifyInstance } from 'fastify';
import { chromium } from 'playwright';

import { createArtifactStore } from '../artifacts/factory.js';
import { FsArtifactStore } from '../artifacts/store.js';
import type { ServerConfig } from '../config.js';
import { evaluateExitCriteria, getSignOff } from '../exit-criteria/evaluate.js';
import { RunCaseJobPayloadSchema } from '../worker/run-lifecycle.js';
import type { ServerRuntime } from '../worker/runtime.js';

const FORMATS = {
  junit: { contentType: 'application/xml', file: 'junit.xml' },
  html: { contentType: 'text/html; charset=utf-8', file: 'report.html' },
  json: { contentType: 'application/json', file: 'report.json' },
} as const;

type Format = keyof typeof FORMATS;

/** Absolute screenshot paths per `<caseResultId>:<stepIndex>`, for the HTML reporter. */
type ScreenshotIndex = Map<string, string>;

/**
 * Rebuilds a {@link RunReport} from the database so the existing reporters (JUnit, HTML, JSON) can render a
 * server-side run. Returns undefined when the run does not exist.
 */
export async function buildRunReport(
  db: Db,
  runtime: ServerRuntime,
  config: Pick<ServerConfig, 'artifactsDir' | 's3Bucket' | 's3Endpoint' | 's3PublicEndpoint' | 's3Region' | 's3Prefix'>,
  runId: string,
): Promise<{ report: RunReport; screenshots: ScreenshotIndex; dispose: () => Promise<void> } | undefined> {
  const run = await repos.runs.get(db, runId);
  if (!run) return undefined;
  const jobs = await runtime.queue.listByRun(runId);
  const payload = jobs.map((j) => RunCaseJobPayloadSchema.safeParse(j.payload)).find((p) => p.success);
  const mode = payload?.success ? payload.data.mode : 'replay-heal';
  const results = await repos.results.listCases(db, runId);
  const suites = new Map<string, string>();
  const envs = new Map<string, string>();
  const screenshots: ScreenshotIndex = new Map();
  const store = createArtifactStore(db, config);
  // Remote stores (S3) have no local files: screenshots the HTML reporter embeds are fetched into a temp dir.
  let tmp: string | undefined;
  const dispose = async (): Promise<void> => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  };
  const localShot = async (a: { id: string; path: string }): Promise<string> => {
    if (store instanceof FsArtifactStore) return join(store.root, a.path);
    tmp ??= await mkdtemp(join(tmpdir(), 's1p-report-'));
    const chunks: Buffer[] = [];
    for await (const chunk of await store.get(a.id)) chunks.push(Buffer.from(chunk as Uint8Array));
    const file = join(tmp, `${a.id}.png`);
    await writeFile(file, Buffer.concat(chunks));
    return file;
  };
  const startedAt = run.startedAt ?? new Date().toISOString();

  const cases: CaseRunResult[] = [];
  for (const r of results) {
    const c = await repos.cases.get(db, r.caseId);
    if (c?.suiteId && !suites.has(c.suiteId)) suites.set(c.suiteId, (await repos.suites.get(db, c.suiteId))?.name ?? 'default');
    if (r.environmentId && !envs.has(r.environmentId)) envs.set(r.environmentId, (await repos.environments.get(db, r.environmentId))?.name ?? '');
    const steps = await repos.results.listSteps(db, r.id);
    const artifacts = await repos.artifacts.listByCaseResult(db, r.id);
    const shots = new Map(artifacts.filter((a) => a.kind === 'screenshot' && a.stepIndex !== undefined).map((a) => [a.stepIndex, a] as const));
    for (const [stepIndex, shot] of shots) screenshots.set(`${r.id}:${stepIndex}`, await localShot(shot));
    const stepReports: StepReport[] = steps.map((s) => {
      const shot = artifacts.find((a) => a.kind === 'screenshot' && a.stepIndex === s.stepIndex);
      return {
        index: s.stepIndex,
        action: c?.steps[s.stepIndex]?.action ?? `Step ${s.stepIndex + 1}`,
        verdict: s.status,
        ...(s.mode ? { mode: s.mode } : {}),
        ...(s.actionTaken ? { actionTaken: s.actionTaken } : {}),
        actions: 0,
        iterations: 0,
        durationMs: s.latencyMs,
        assertions: s.assertions,
        decisions: s.decisions,
        ...(shot ? { screenshot: shot.name } : {}),
      };
    });
    const files = artifacts
      .filter((a) => a.kind === 'video' || a.kind === 'trace' || a.kind === 'log' || a.kind === 'console' || a.kind === 'network')
      .map((a) => ({ kind: a.kind as 'video' | 'trace' | 'log' | 'console' | 'network', file: a.name, contentType: a.contentType }));
    cases.push({
      runId,
      caseResultId: r.id,
      key: c?.key ?? r.caseId,
      title: c?.title ?? '',
      suite: (c?.suiteId && suites.get(c.suiteId)) || 'default',
      priority: c?.priority ?? 'P2',
      row: 1,
      mode: r.mode,
      verdict: r.verdict,
      environment: (r.environmentId && envs.get(r.environmentId)) || '',
      browser: (r.browser ?? 'chromium') as BrowserName,
      params: {},
      scriptKey: c?.key ?? r.caseId,
      dir: r.id,
      startedAt,
      durationMs: r.durationMs,
      healProposals: 0,
      steps: stepReports,
      ...(files.length > 0 ? { files } : {}),
    });
  }
  const allSteps = cases.flatMap((c) => c.steps);
  const passedSteps = allSteps.filter((s) => s.verdict === 'passed').length;
  const finishedAt = run.finishedAt ?? startedAt;
  const report = RunReportSchema.parse({
    runId,
    environment: [...new Set(cases.map((c) => c.environment).filter(Boolean))].join(', '),
    browser: cases[0]?.browser ?? 'chromium',
    mode,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    totals: run.summary,
    steps: { executed: allSteps.length, passed: passedSteps, successRate: allSteps.length === 0 ? 0 : passedSteps / allSteps.length },
    cases,
  });
  return { report, screenshots, dispose };
}

/**
 * Registers `GET /api/runs/:id/export/:format` (`junit` | `html` | `json`) which renders a finished or running
 * run with the S-027 / S-028 reporters as a download.
 */
export function registerExportRoutes(app: FastifyInstance, deps: { db: Db; runtime: ServerRuntime; config: Pick<ServerConfig, 'artifactsDir' | 's3Bucket' | 's3Endpoint' | 's3PublicEndpoint' | 's3Region' | 's3Prefix'> }): void {
  /** `GET /api/runs/:id/export.pdf`: summary + exit criteria + sign-off rendered to PDF with Chromium. */
  app.get<{ Params: { id: string } }>('/api/runs/:id/export.pdf', async (req, reply) => {
    const built = await buildRunReport(deps.db, deps.runtime, deps.config, req.params.id);
    if (!built) return reply.code(404).send({ error: 'Run not found' });
    const run = await repos.runs.get(deps.db, req.params.id);
    const plan = run?.planId ? await repos.plans.get(deps.db, run.planId) : undefined;
    await built.dispose();
    const evaluation = run ? await evaluateExitCriteria(run, plan, deps.db) : undefined;
    const html = renderSummaryHtml(built.report, {
      title: plan ? `${plan.name} · run summary` : 'Run summary',
      criteria: evaluation?.items ?? [],
      signOff: await getSignOff(deps.db, req.params.id),
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' } });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="run-${req.params.id}-summary.pdf"`)
        .header('x-content-type-options', 'nosniff')
        .send(pdf);
    } finally {
      await browser.close();
    }
  });

  app.get<{ Params: { id: string; format: string } }>('/api/runs/:id/export/:format', async (req, reply) => {
    const format = req.params.format as Format;
    if (!(format in FORMATS)) return reply.code(400).send({ error: `Unknown format: ${req.params.format}` });
    const built = await buildRunReport(deps.db, deps.runtime, deps.config, req.params.id);
    if (!built) return reply.code(404).send({ error: 'Run not found' });
    const { report, screenshots } = built;
    let body: string;
    try {
      body =
        format === 'junit'
          ? renderJunit(report)
          : format === 'json'
            ? renderJson(report)
            : await renderHtml(report, { screenshots: (c, step) => [screenshots.get(`${c.caseResultId}:${step.index}`)].filter((p): p is string => p !== undefined) });
    } finally {
      await built.dispose();
    }
    return reply
      .header('content-type', FORMATS[format].contentType)
      .header('content-disposition', `attachment; filename="run-${req.params.id}-${FORMATS[format].file}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
