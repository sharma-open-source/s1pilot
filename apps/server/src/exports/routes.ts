import { join } from 'node:path';

import { repos, type Db } from '@s1pilot/db';
import {
  RunReportSchema,
  type BrowserName,
  type CaseRunResult,
  type RunReport,
  type StepReport,
} from '@s1pilot/domain';
import { renderHtml, renderJson, renderJunit } from '@s1pilot/reporters';
import type { FastifyInstance } from 'fastify';

import type { ServerConfig } from '../config.js';
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
  config: Pick<ServerConfig, 'artifactsDir'>,
  runId: string,
): Promise<{ report: RunReport; screenshots: ScreenshotIndex } | undefined> {
  const run = await repos.runs.get(db, runId);
  if (!run) return undefined;
  const jobs = await runtime.queue.listByRun(runId);
  const payload = jobs.map((j) => RunCaseJobPayloadSchema.safeParse(j.payload)).find((p) => p.success);
  const mode = payload?.success ? payload.data.mode : 'replay-heal';
  const results = await repos.results.listCases(db, runId);
  const suites = new Map<string, string>();
  const envs = new Map<string, string>();
  const screenshots: ScreenshotIndex = new Map();
  const startedAt = run.startedAt ?? new Date().toISOString();

  const cases: CaseRunResult[] = [];
  for (const r of results) {
    const c = await repos.cases.get(db, r.caseId);
    if (c?.suiteId && !suites.has(c.suiteId)) suites.set(c.suiteId, (await repos.suites.get(db, c.suiteId))?.name ?? 'default');
    if (r.environmentId && !envs.has(r.environmentId)) envs.set(r.environmentId, (await repos.environments.get(db, r.environmentId))?.name ?? '');
    const steps = await repos.results.listSteps(db, r.id);
    const artifacts = await repos.artifacts.listByCaseResult(db, r.id);
    const stepReports: StepReport[] = steps.map((s) => {
      const shot = artifacts.find((a) => a.kind === 'screenshot' && a.stepIndex === s.stepIndex);
      if (shot) screenshots.set(`${r.id}:${s.stepIndex}`, join(config.artifactsDir, shot.path));
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
  return { report, screenshots };
}

/**
 * Registers `GET /api/runs/:id/export/:format` (`junit` | `html` | `json`) which renders a finished or running
 * run with the S-027 / S-028 reporters as a download.
 */
export function registerExportRoutes(app: FastifyInstance, deps: { db: Db; runtime: ServerRuntime; config: Pick<ServerConfig, 'artifactsDir'> }): void {
  app.get<{ Params: { id: string; format: string } }>('/api/runs/:id/export/:format', async (req, reply) => {
    const format = req.params.format as Format;
    if (!(format in FORMATS)) return reply.code(400).send({ error: `Unknown format: ${req.params.format}` });
    const built = await buildRunReport(deps.db, deps.runtime, deps.config, req.params.id);
    if (!built) return reply.code(404).send({ error: 'Run not found' });
    const { report, screenshots } = built;
    const body =
      format === 'junit'
        ? renderJunit(report)
        : format === 'json'
          ? renderJson(report)
          : await renderHtml(report, { screenshots: (c, step) => [screenshots.get(`${c.caseResultId}:${step.index}`)].filter((p): p is string => p !== undefined) });
    return reply
      .header('content-type', FORMATS[format].contentType)
      .header('content-disposition', `attachment; filename="run-${req.params.id}-${FORMATS[format].file}"`)
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
}
