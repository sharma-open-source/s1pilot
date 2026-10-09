import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import {
  LINE_STYLES,
  RANGES,
  VIEWS,
  dayLabel,
  flakinessPct,
  formatDuration,
  formatPct,
  toCsv,
  type AnalyticsSearch,
  type AnalyticsView,
  type Range,
} from './model';

import { ModeMixBar } from '@/components/app/ModeMixBar';
import { PageHeader } from '@/components/app/PageHeader';
import { StatTile, StatTileSkeleton } from '@/components/app/StatTile';
import {
  Button,
  Callout,
  Card,
  DropdownContent,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
  EmptyState,
  Skeleton,
  StatusPill,
  Tabs,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Series = RouterOutputs['analytics']['passRateSeries'];
type BySuite = RouterOutputs['analytics']['resultsBySuite'];
type Flaky = RouterOutputs['analytics']['flakyTop'];
type Slowest = RouterOutputs['analytics']['slowestTop'];
type AiQuality = RouterOutputs['analytics']['aiQuality'];
type Readiness = RouterOutputs['analytics']['releaseReadiness'];
type Coverage = RouterOutputs['analytics']['coverage'];

const linkClass = 'text-primary-text hover:text-primary-text-hover';
const ALL = '__all';

const withoutKey = (s: AnalyticsSearch, key: keyof AnalyticsSearch): AnalyticsSearch =>
  Object.fromEntries(Object.entries(s).filter(([k]) => k !== key));

function A({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <Link to={to as never} className={className ?? linkClass}>
      {children}
    </Link>
  );
}

function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Callout tone="danger" className="flex flex-wrap items-center justify-between gap-3">
      <span>Could not load this section: {errorMessage(error)}</span>
      <Button size="sm" onClick={onRetry}>Retry</Button>
    </Callout>
  );
}

/** Pill-shaped dropdown button with a single-choice menu (header filters). */
function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  const current = options.find(([v]) => v === value)?.[1] ?? options[0]?.[1] ?? '';
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current}`}
          className="min-h-[44px] rounded-pill border border-line-input bg-surface px-3.5 text-[13px] text-fg"
        >
          {current} ▾
        </button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownRadioGroup value={value} onValueChange={onChange}>
          {options.map(([v, text]) => (
            <DropdownRadioItem key={v} value={v}>
              {text}
            </DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
      </DropdownContent>
    </DropdownMenu>
  );
}

function ChartLegend({ items }: { items: Array<{ label: string; className?: string; style?: React.CSSProperties }> }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px] text-secondary">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-2.5 w-4 rounded-sm ${i.className ?? ''}`} style={i.style} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const NO_RUNS = 'No runs in this period';

function ChartEmpty({ children = NO_RUNS }: { children?: string }) {
  return <EmptyState className="h-[200px] items-center justify-center text-center">{children}</EmptyState>;
}

/** One line per environment; the selected environment is drawn in `--primary`. */
export function PassRateChart({ series, selectedEnv }: { series: Series; selectedEnv: string | undefined }) {
  if (series.total === 0) return <ChartEmpty />;
  const data = series.points.map((p) => ({ label: dayLabel(p.day), ...p.rates }));
  const style = (name: string, i: number) =>
    selectedEnv === name ? { stroke: 'var(--primary)', dash: undefined } : (LINE_STYLES[i % LINE_STYLES.length] ?? LINE_STYLES[0]);
  const latest = series.environments.map((name) => {
    const last = [...series.points].reverse().find((p) => p.rates[name] !== null && p.rates[name] !== undefined);
    return `${name} ${formatPct(last?.rates[name] ?? null)}`;
  });
  return (
    <figure className="m-0 flex flex-col gap-3">
      <div role="img" aria-label={`Daily pass rate by environment, ${data.length} days. Latest: ${latest.join(', ')}.`} className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--divider-row)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-muted)' }} stroke="var(--border-input)" minTickGap={24} />
            <YAxis domain={[0, 100]} unit="%" width={44} tick={{ fontSize: 12, fill: 'var(--text-muted)' }} stroke="var(--border-input)" />
            <Tooltip formatter={(v) => (typeof v === 'number' ? `${v}%` : '—')} />
            {series.environments.map((name, i) => {
              const s = style(name, i);
              return (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={s.stroke}
                  strokeWidth={2}
                  {...(s.dash ? { strokeDasharray: s.dash } : {})}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption>
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px] text-secondary" aria-label="Legend">
          {series.environments.map((name, i) => {
            const s = style(name, i);
            return (
              <li key={name} className="flex items-center gap-1.5">
                <svg width="22" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="22" y2="4" stroke={s.stroke} strokeWidth="2" {...(s.dash ? { strokeDasharray: s.dash } : {})} />
                </svg>
                {name}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Stacked horizontal bars: passed `--chart-1`, review `--warning-bar`, failed `--danger`. */
export function SuiteBars({ rows }: { rows: BySuite }) {
  if (rows.length === 0) return <ChartEmpty />;
  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      {rows.map((r) => (
        <div key={r.suiteId ?? 'none'} className="flex items-center gap-2.5">
          <span className="w-[110px] shrink-0 truncate" title={r.suite}>
            {r.suite}
          </span>
          <div
            role="img"
            aria-label={`${r.suite}: ${r.passed} passed, ${r.review} review, ${r.failed} failed`}
            className="flex h-3.5 flex-1 overflow-hidden rounded-[3px] bg-track"
          >
            <div data-segment="passed" style={{ flex: r.passed }} className="bg-chart-1" />
            <div data-segment="review" style={{ flex: r.review }} className="bg-warning-bar" />
            <div data-segment="failed" style={{ flex: r.failed }} className="bg-danger" />
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-muted">{r.total}</span>
        </div>
      ))}
      <ChartLegend
        items={[
          { label: 'Passed', className: 'bg-chart-1' },
          { label: 'Review', className: 'bg-warning-bar' },
          { label: 'Failed (incl. flaky)', className: 'bg-danger' },
        ]}
      />
    </div>
  );
}

function RankList({ children, empty }: { children: React.ReactNode[]; empty: string }) {
  if (children.length === 0) return <p className="m-0 text-[13px] text-muted">{empty}</p>;
  return <ul className="m-0 flex list-none flex-col p-0 text-sm">{children}</ul>;
}

function FlakyCard({ projectKey, data }: { projectKey: string; data: Flaky | undefined }) {
  return (
    <Card aria-label="Flaky cases" className="flex flex-col gap-2.5 p-[18px]">
      <div className="flex justify-between gap-3">
        <h2 className="text-base font-semibold">Most flaky</h2>
        <A to={`/p/${encodeURIComponent(projectKey)}/cases?q=quarantined%3Ayes`}>Quarantine list</A>
      </div>
      {data === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <RankList empty="No flaky cases detected.">
          {data.map((f) => (
            <li key={f.key} className="flex justify-between gap-3 border-b border-divider-row py-2 last:border-b-0">
              <span className="min-w-0 truncate">
                <A to={`/p/${encodeURIComponent(projectKey)}/cases/${encodeURIComponent(f.key)}`}>
                  <span className="font-mono">{f.key}</span>
                </A>{' '}
                · {f.title}
                {f.quarantined && <span className="ml-2 text-xs text-muted">quarantined</span>}
              </span>
              <span className="font-mono">{flakinessPct(f.flakiness)}</span>
            </li>
          ))}
        </RankList>
      )}
    </Card>
  );
}

function SlowestCard({ projectKey, data }: { projectKey: string; data: Slowest | undefined }) {
  return (
    <Card aria-label="Slowest cases" className="flex flex-col gap-2.5 p-[18px]">
      <h2 className="text-base font-semibold">Slowest cases</h2>
      {data === undefined ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <RankList empty={NO_RUNS}>
          {data.map((s) => (
            <li key={s.key} className="flex justify-between gap-3 border-b border-divider-row py-2 last:border-b-0">
              <span className="min-w-0 truncate">
                <A to={`/p/${encodeURIComponent(projectKey)}/cases/${encodeURIComponent(s.key)}`}>
                  <span className="font-mono">{s.key}</span>
                </A>{' '}
                · {s.title}
              </span>
              <span className="whitespace-nowrap font-mono">
                {formatDuration(s.avgDurationMs)} · {s.mode}
              </span>
            </li>
          ))}
        </RankList>
      )}
    </Card>
  );
}

/** The six System 1 quality tiles with the recalibration row. */
export function AiQualityCard({ data, error, onRetry }: { data: AiQuality | undefined; error: unknown; onRetry: () => void }) {
  const tiles = (d: AiQuality): Array<[string, string]> => [
    ['Escalated to S2 / human', formatPct(d.escalationRate)],
    ['Verdicts needing review', formatPct(d.needsReviewRate)],
    ['Overridden by humans', formatPct(d.overrideRate)],
    ['Calibration error (ECE)', d.ece === null ? '—' : d.ece.toFixed(3)],
    ['Decision latency p50 / p95', `${formatDuration(d.latencyP50)} / ${formatDuration(d.latencyP95)}`],
    ['Heal success', formatPct(d.healSuccessRate)],
  ];
  return (
    <Card aria-label="AI model quality" className="flex flex-col gap-3.5 p-[18px]">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="text-base font-semibold">AI model quality · System 1{data?.model ? ` (${data.model})` : ''}</h2>
        <A to="/settings/models">Compare models</A>
      </div>
      {error !== null && error !== undefined ? (
        <QueryError error={error} onRetry={onRetry} />
      ) : data === undefined ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            {tiles(data).map(([label, value]) => (
              <div key={label} className="rounded-control bg-surface-subtle p-3">
                <div className="text-xs text-muted">{label}</div>
                <div className="font-mono text-xl font-semibold">{value}</div>
              </div>
            ))}
          </div>
          {data.decisions === 0 && <p className="m-0 text-[13px] text-muted">No model decisions in this period.</p>}
          <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-secondary">
            {/* TODO(S-058): enable once calibration.fit exists. */}
            <Button size="sm" disabled title="Calibration is added by S-058">
              Recalibrate from {data.reviewedDecisions} reviewed decisions
            </Button>
            {data.lastTunedAt === null ? 'Thresholds have not been tuned yet.' : `Thresholds were last tuned ${data.lastTunedAt.slice(0, 10)}.`}
          </div>
        </>
      )}
    </Card>
  );
}

function QualityView({
  projectKey,
  search,
  q,
}: {
  projectKey: string;
  search: AnalyticsSearch;
  q: ReturnType<typeof useAnalyticsQueries>;
}) {
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] gap-5">
        <Card aria-label="Pass rate trend" className="flex flex-col gap-3 p-[18px]">
          <div className="flex justify-between gap-3">
            <h2 className="text-base font-semibold">Pass rate over time</h2>
            <span className="text-[13px] text-secondary">by environment</span>
          </div>
          {q.series.isError ? (
            <QueryError error={q.series.error} onRetry={() => void q.series.refetch()} />
          ) : q.series.data === undefined ? (
            <Skeleton className="h-[200px] w-full" />
          ) : (
            <PassRateChart series={q.series.data} selectedEnv={search.env} />
          )}
        </Card>
        <Card aria-label="Results by suite" className="flex flex-col gap-3 p-[18px]">
          <h2 className="text-base font-semibold">Results by suite</h2>
          {q.bySuite.isError ? (
            <QueryError error={q.bySuite.error} onRetry={() => void q.bySuite.refetch()} />
          ) : q.bySuite.data === undefined ? (
            <Skeleton className="h-[200px] w-full" />
          ) : (
            <SuiteBars rows={q.bySuite.data} />
          )}
        </Card>
        <FlakyCard projectKey={projectKey} data={q.flaky.data} />
        <SlowestCard projectKey={projectKey} data={q.slowest.data} />
      </div>
      <Card aria-label="Execution mode mix" className="flex flex-col gap-3.5 p-[18px]">
        <h2 className="text-base font-semibold">How steps were executed</h2>
        {q.mix.data === undefined ? <Skeleton className="h-7 w-full" /> : <ModeMixBar mix={q.mix.data} />}
      </Card>
      <AiQualityCard data={q.ai.data} error={q.ai.error} onRetry={() => void q.ai.refetch()} />
    </>
  );
}

function ReadinessView({ projectKey, query }: { projectKey: string; query: { data: Readiness | undefined; isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return <Skeleton className="h-40 w-full" />;
  if (query.data.length === 0) {
    return (
      <EmptyState action={<A to={`/p/${encodeURIComponent(projectKey)}/plans`}>Create a test plan</A>}>
        No test plans yet. Plans with exit criteria show their release readiness here.
      </EmptyState>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))] gap-5">
      {query.data.map((p) => (
        <Card key={p.planId} aria-label={`Plan ${p.plan}`} className="flex flex-col gap-3 p-[18px]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">{p.plan}</h2>
              <span className="text-[13px] text-muted">{p.release ? `Release ${p.release}` : 'No release set'}</span>
            </div>
            {p.criteria === null ? (
              <StatusPill status="not-run" label="No run yet" />
            ) : p.criteria.total === 0 ? (
              <StatusPill status="draft" label="No criteria" />
            ) : p.criteria.allMet ? (
              <StatusPill status="passed" label="Ready" />
            ) : (
              <StatusPill status="failed" label="Not ready" />
            )}
          </div>
          {p.run === null ? (
            <p className="m-0 text-[13px] text-muted">This plan has not been run yet.</p>
          ) : (
            <p className="m-0 text-[13px] text-secondary">
              Latest run{' '}
              <A to={`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(p.run.id)}`}>
                <span className="font-mono">{p.run.buildRef ?? p.run.id}</span>
              </A>
              {p.run.startedAt && <> · <time dateTime={p.run.startedAt}>{p.run.startedAt.slice(0, 16).replace('T', ' ')}</time></>}
              {p.criteria !== null && p.criteria.total > 0 && <> · {p.criteria.met} of {p.criteria.total} criteria met</>}
            </p>
          )}
          {p.criteria !== null && (
            <ul className="m-0 flex list-none flex-col p-0 text-sm">
              {p.criteria.items.map((c, i) => (
                <li key={i} className="flex items-start justify-between gap-3 border-b border-divider-row py-2 last:border-b-0">
                  <span>
                    <span className={c.met ? 'text-success' : 'text-danger'}>{c.met ? '✓ Met' : '✗ Not met'}</span> · {c.label}
                    {c.detail && <span className="block text-[13px] text-muted">{c.detail}</span>}
                  </span>
                  <span className="whitespace-nowrap font-mono text-[13px]">{c.actual}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}

const COVERAGE_PILL: Record<Coverage[number]['status'], { status: string; label: string }> = {
  passing: { status: 'passed', label: 'Passing' },
  failing: { status: 'failed', label: 'Failing' },
  review: { status: 'needs-review', label: 'Review' },
  'not-run': { status: 'not-run', label: 'Not run' },
  uncovered: { status: 'draft', label: 'Uncovered' },
};

function CoverageView({ projectKey, query }: { projectKey: string; query: { data: Coverage | undefined; isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return <Skeleton className="h-40 w-full" />;
  if (query.data.length === 0) {
    return <EmptyState>No requirements yet. Link test cases to requirements to see coverage.</EmptyState>;
  }
  return (
    <Card aria-label="Requirement coverage">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Requirements, covering cases and the last result of each case</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
              <th scope="col" className="px-[18px] py-2.5 font-medium">Requirement</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Coverage</th>
              <th scope="col" className="px-[18px] py-2.5 font-medium">Cases · last result</th>
            </tr>
          </thead>
          <tbody>
            {query.data.map((r) => {
              const pill = COVERAGE_PILL[r.status];
              return (
                <tr key={r.key} className="border-t border-divider-row align-top">
                  <td className="px-[18px] py-3">
                    <span className="font-mono text-[13px]">{r.key}</span>
                    <div>{r.title}</div>
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill status={pill.status} label={pill.label} />
                  </td>
                  <td className="px-[18px] py-3">
                    {r.cases.length === 0 ? (
                      <span className="text-muted">No covering case</span>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {r.cases.map((c) => (
                          <li key={c.key} className="flex flex-wrap items-center gap-2">
                            <A to={`/p/${encodeURIComponent(projectKey)}/cases/${encodeURIComponent(c.key)}`}>
                              <span className="font-mono">{c.key}</span>
                            </A>
                            <span className="text-secondary">{c.title}</span>
                            {c.lastVerdict === null ? <StatusPill status="not-run" label="Not run" /> : <StatusPill status={c.lastVerdict} />}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Queries of the current view; the others stay disabled so a tab only loads what it shows. */
function useAnalyticsQueries(projectKey: string, view: AnalyticsView, search: AnalyticsSearch) {
  const input = {
    projectKey,
    range: search.range ?? 30,
    ...(search.env ? { environment: search.env } : {}),
    ...(search.suite ? { suite: search.suite } : {}),
  };
  const quality = view === 'quality';
  const ai = view === 'quality' || view === 'ai';
  return {
    series: trpc.analytics.passRateSeries.useQuery(input, { enabled: quality }),
    bySuite: trpc.analytics.resultsBySuite.useQuery(input, { enabled: quality }),
    flaky: trpc.analytics.flakyTop.useQuery(input, { enabled: quality }),
    slowest: trpc.analytics.slowestTop.useQuery(input, { enabled: quality }),
    mix: trpc.analytics.modeMix.useQuery(input, { enabled: quality }),
    ai: trpc.analytics.aiQuality.useQuery(input, { enabled: ai }),
    readiness: trpc.analytics.releaseReadiness.useQuery({ projectKey }, { enabled: view === 'readiness' }),
    coverage: trpc.analytics.coverage.useQuery({ projectKey, ...(search.suite ? { suite: search.suite } : {}) }, { enabled: view === 'coverage' }),
  };
}

/** CSV of what the current view shows (undefined while its data is loading). */
export function exportRows(view: AnalyticsView, q: ReturnType<typeof useAnalyticsQueries>): Array<Array<string | number | null>> | undefined {
  switch (view) {
    case 'quality': {
      const { series, bySuite, flaky, slowest } = q;
      if (!series.data || !bySuite.data || !flaky.data || !slowest.data) return undefined;
      return [
        ['Pass rate over time (%)', ...series.data.environments],
        ...series.data.points.map((p) => [p.day, ...series.data.environments.map((e) => p.rates[e] ?? null)]),
        [],
        ['Suite', 'Passed', 'Review', 'Failed', 'Flaky'],
        ...bySuite.data.map((r) => [r.suite, r.passed, r.review, r.failed, r.flaky]),
        [],
        ['Most flaky', 'Title', 'Flakiness %'],
        ...flaky.data.map((f) => [f.key, f.title, Math.round(f.flakiness * 100)]),
        [],
        ['Slowest cases', 'Title', 'Avg duration ms', 'Mode'],
        ...slowest.data.map((s) => [s.key, s.title, s.avgDurationMs, s.mode]),
      ];
    }
    case 'ai': {
      const d = q.ai.data;
      if (!d) return undefined;
      return [
        ['Metric', 'Value'],
        ['Escalated to S2 / human %', d.escalationRate],
        ['Verdicts needing review %', d.needsReviewRate],
        ['Overridden by humans %', d.overrideRate],
        ['Calibration error (ECE)', d.ece],
        ['Decision latency p50 ms', d.latencyP50],
        ['Decision latency p95 ms', d.latencyP95],
        ['Heal success %', d.healSuccessRate],
      ];
    }
    case 'readiness': {
      if (!q.readiness.data) return undefined;
      return [
        ['Plan', 'Release', 'Latest run', 'Criteria met', 'Criteria total', 'Ready'],
        ...q.readiness.data.map((p) => [p.plan, p.release, p.run?.buildRef ?? p.run?.id ?? null, p.criteria?.met ?? null, p.criteria?.total ?? null, p.criteria ? (p.criteria.allMet ? 'yes' : 'no') : null]),
      ];
    }
    case 'coverage': {
      if (!q.coverage.data) return undefined;
      return [
        ['Requirement', 'Title', 'Coverage', 'Case', 'Last result'],
        ...q.coverage.data.flatMap((r) =>
          r.cases.length === 0 ? [[r.key, r.title, r.status, null, null]] : r.cases.map((c) => [r.key, r.title, r.status, c.key, c.lastVerdict]),
        ),
      ];
    }
  }
}

/** Saves `text` as a CSV download. */
function downloadCsv(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Analytics screen (`/p/:key/analytics/:view`, wireframe 12): filters, four views and CSV export. */
export function AnalyticsPage({ projectKey, view, search }: { projectKey: string; view: AnalyticsView; search: AnalyticsSearch }) {
  const navigate = useNavigate();
  const [exportError, setExportError] = useState<string | null>(null);
  const q = useAnalyticsQueries(projectKey, view, search);
  const envs = trpc.environments.list.useQuery({ projectKey });
  const suites = trpc.suites.tree.useQuery({ projectKey });

  const setSearch = (next: AnalyticsSearch) =>
    void navigate({ to: `/p/${encodeURIComponent(projectKey)}/analytics/${view}` as never, search: next as never });
  const range: Range = search.range ?? 30;

  const flatSuites: Array<[string, string]> = [];
  const walk = (nodes: NonNullable<typeof suites.data>['tree'], depth: number) => {
    for (const n of nodes) {
      flatSuites.push([n.id, `${'– '.repeat(depth)}${n.name}`]);
      walk(n.children as never, depth + 1);
    }
  };
  if (suites.data) walk(suites.data.tree, 0);

  const onExport = () => {
    const rows = exportRows(view, q);
    if (rows === undefined) return;
    try {
      downloadCsv(`${projectKey}-analytics-${view}.csv`, toCsv(rows));
      setExportError(null);
    } catch (err) {
      setExportError(errorMessage(err));
    }
  };

  const base = `/p/${encodeURIComponent(projectKey)}/analytics`;
  const showFilters = view === 'quality' || view === 'ai';

  return (
    <>
      <PageHeader
        eyebrow={projectKey}
        title="Analytics"
        actions={
          <>
            {showFilters && (
              <>
                <FilterMenu
                  label="Date range"
                  value={String(range)}
                  options={RANGES.map(([v, l]) => [String(v), l])}
                  onChange={(v) => setSearch({ ...search, range: Number(v) as Range })}
                />
                <FilterMenu
                  label="Environment"
                  value={search.env ?? ALL}
                  options={[[ALL, 'All environments'], ...(envs.data ?? []).map((e): [string, string] => [e.name, e.name])]}
                  onChange={(v) => {
                    setSearch({ ...withoutKey(search, 'env'), ...(v === ALL ? {} : { env: v }) });
                  }}
                />
              </>
            )}
            {(showFilters || view === 'coverage') && (
              <FilterMenu
                label="Suite"
                value={search.suite ?? ALL}
                options={[[ALL, 'All suites'], ...flatSuites]}
                onChange={(v) => {
                  setSearch({ ...withoutKey(search, 'suite'), ...(v === ALL ? {} : { suite: v }) });
                }}
              />
            )}
            <Button onClick={onExport} aria-label="Export current view as CSV">Export</Button>
          </>
        }
      />
      {exportError !== null && <Callout tone="danger">Could not export: {exportError}</Callout>}
      <Tabs aria-label="Analytics views" items={VIEWS.map(([id, label]) => ({ label, to: `${base}/${id}` }))} />

      {view === 'quality' && <QualityView projectKey={projectKey} search={search} q={q} />}
      {view === 'readiness' && <ReadinessView projectKey={projectKey} query={q.readiness} />}
      {view === 'coverage' && <CoverageView projectKey={projectKey} query={q.coverage} />}
      {view === 'ai' && (
        <>
          {q.ai.data === undefined && !q.ai.isError && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
              <StatTileSkeleton label="Decisions" />
            </div>
          )}
          {q.ai.data !== undefined && (
            <StatTile label="System 1 decisions in this period" value={q.ai.data.decisions} className="max-w-[320px]" />
          )}
          <AiQualityCard data={q.ai.data} error={q.ai.error} onRetry={() => void q.ai.refetch()} />
        </>
      )}
    </>
  );
}
