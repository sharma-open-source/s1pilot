import { keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { CasePickerDialog } from './CasePickerDialog';
import { DeletePlanDialog } from './DeletePlanDialog';
import { ManualAssignments } from './ManualAssignments';
import {
  blankForm,
  changeDevice,
  CRITERION_TEMPLATES,
  criterionText,
  describeCron,
  DEFAULT_CRON,
  formFromPlan,
  MODE_OPTIONS,
  SEVERITIES,
  toDraft,
  toggleCell,
  UNATTENDED_OPTIONS,
  validateForm,
  type FormProblems,
  type PlanEnv,
  type PlanForm,
  type StoredPlan,
} from './model';

import { MatrixTable } from '@/components/app/MatrixTable';
import { PageHeader } from '@/components/app/PageHeader';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Select,
  Skeleton,
} from '@/components/ui';
import { Segmented } from '@/components/ui/segmented';
import { errorMessage } from '@/lib/errors';
import { Can } from '@/lib/session';
import { trpc } from '@/lib/trpc';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Chip({ tone, children }: { tone?: 'warning' | 'flaky'; children: ReactNode }) {
  const cls = tone === 'warning' ? 'bg-warning-soft text-warning-strong' : tone === 'flaky' ? 'bg-flaky-soft text-flaky' : 'bg-surface-muted text-fg';
  return <span className={`rounded-tag px-2.5 py-1.5 text-[13px] ${cls}`}>{children}</span>;
}

const sectionCls = 'flex flex-col gap-3.5 p-5';

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : Math.max(min, Math.min(max, n));
}

interface BuilderProps {
  projectKey: string;
  projectLabel: string;
  envs: PlanEnv[];
  plan?: StoredPlan;
}

/** Webhook URL of a saved plan with a button to issue a new token (S-052). */
function WebhookInfo({ planId }: { planId: string }) {
  const utils = trpc.useUtils();
  const info = trpc.triggers.get.useQuery(planId, { retry: false });
  const regenerate = trpc.triggers.regenerateToken.useMutation({ onSuccess: () => utils.triggers.get.invalidate(planId) });
  if (info.isLoading) return <span className="text-xs text-muted">Loading webhook URL…</span>;
  if (info.data === undefined) return <span className="text-xs text-danger">Could not load the webhook URL.</span>;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <>
      <code className="break-all font-mono text-xs text-fg">POST {origin}{info.data.webhookPath}</code>
      <span className="text-xs text-muted">Optional JSON body: buildRef, environment, commit.</span>
      <Button variant="secondary" className="self-start" disabled={regenerate.isPending} onClick={() => regenerate.mutate(planId)}>
        Regenerate token
      </Button>
    </>
  );
}

/** One checkbox per notification channel: "Notify <channel> on finish" adds or removes a plan-scoped rule (S-065). */
function NotifyOnFinish({ planId, projectKey }: { planId: string; projectKey: string }) {
  const utils = trpc.useUtils();
  const channels = trpc.notifications.channels.list.useQuery();
  const rules = trpc.notifications.rules.list.useQuery();
  const save = trpc.notifications.rules.save.useMutation({ onSuccess: () => utils.notifications.rules.list.invalidate() });
  const del = trpc.notifications.rules.delete.useMutation({ onSuccess: () => utils.notifications.rules.list.invalidate() });
  if (channels.data === undefined || rules.data === undefined) return <span className="text-xs text-muted">Loading notification channels…</span>;
  if (channels.data.length === 0) {
    return (
      <Link to="/settings/$section" params={{ section: 'notifications' }} className="text-[13px] text-primary-text">
        Add a Slack, Teams or email channel in Settings › Notifications to be notified on finish
      </Link>
    );
  }
  return (
    <>
      {channels.data.map((c) => {
        const rule = rules.data.find((r) => r.planId === planId && r.channelId === c.id && r.events.includes('run.finished'));
        return (
          <Checkbox
            key={c.id}
            label={`Notify ${c.name} on finish`}
            checked={rule !== undefined}
            disabled={save.isPending || del.isPending}
            onChange={(e) => (e.target.checked ? save.mutate({ channelId: c.id, projectKey, planId, events: ['run.finished'], onlyOnFailure: false, reviewThreshold: 10 }) : rule && del.mutate({ id: rule.id }))}
          />
        );
      })}
    </>
  );
}

function PlanBuilder({ projectKey, projectLabel, envs, plan }: BuilderProps) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const create = trpc.plans.create.useMutation();
  const update = trpc.plans.update.useMutation();
  const createRun = trpc.runs.create.useMutation();

  const initial = useMemo(() => (plan !== undefined ? formFromPlan(plan) : blankForm(envs)), [plan, envs]);
  const [form, setForm] = useState<PlanForm>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(toDraft(initial)));
  const [planId, setPlanId] = useState<string | undefined>(plan?.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [errors, setErrors] = useState<FormProblems>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const set = (p: Partial<PlanForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setNotice(null);
  };

  const dirty = JSON.stringify(toDraft(form)) !== baseline;
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Live preview, debounced so typing a query does not fire a request per keystroke.
  const draft = toDraft(form);
  const { release: _release, schedule: _schedule, ...forPreview } = draft as ReturnType<typeof toDraft> & { release?: string; schedule?: string };
  void _release;
  void _schedule;
  const previewInput = useMemo(
    () => ({
      projectKey,
      ...forPreview,
      name: 'Draft plan',
      exitCriteria: [],
      includeQuarantined: false,
    }),
    [projectKey, JSON.stringify(forPreview)],
  );
  const debouncedInput = useDebounced(previewInput, 300);
  const previewEnabled = form.matrix.length > 0 && (form.selectionKind === 'list' || form.query.trim() !== '');
  const preview = trpc.plans.preview.useQuery(debouncedInput, { enabled: previewEnabled, retry: false, placeholderData: keepPreviousData });
  const pv = previewEnabled && !preview.isError ? preview.data : undefined;
  // Counts from the previous query stay on screen while the new one is debounced or fetched; mark them as stale.
  const previewStale = pv !== undefined && (debouncedInput !== previewInput || preview.isPlaceholderData);
  const queryError = form.selectionKind === 'query' && preview.isError ? errorMessage(preview.error) : undefined;

  const save = async (): Promise<string | undefined> => {
    const problems = validateForm(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return undefined;
    setServerError(null);
    try {
      let id = planId;
      if (id === undefined) {
        const created = await create.mutateAsync({ projectKey, ...toDraft(form) });
        id = created.id;
        setPlanId(id);
      } else {
        // Empty strings clear the optional fields (a patch cannot carry `undefined`).
        await update.mutateAsync({ id, patch: { ...toDraft(form), release: form.release.trim(), schedule: form.scheduleOn ? form.cron.trim() : '' } });
      }
      setBaseline(JSON.stringify(toDraft(form)));
      setNotice('Plan saved');
      await Promise.all([utils.plans.list.invalidate(), utils.plans.get.invalidate(id)]);
      return id;
    } catch (err) {
      setServerError(errorMessage(err));
      return undefined;
    }
  };

  const wasNew = plan === undefined;
  const onSave = async () => {
    const id = await save();
    if (id !== undefined && wasNew) void navigate({ to: `/p/${encodeURIComponent(projectKey)}/plans/${encodeURIComponent(id)}` as never, replace: true });
  };
  const onRun = async () => {
    const id = await save();
    if (id === undefined) return;
    try {
      const run = await createRun.mutateAsync({ projectKey, planId: id });
      void navigate({ to: `/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(run.id)}/live` as never });
    } catch (err) {
      setServerError(errorMessage(err));
    }
  };
  const busy = create.isPending || update.isPending || createRun.isPending;

  const cron = describeCron(form.cron);
  const base = `/p/${encodeURIComponent(projectKey)}/plans`;
  const manualCases = pv?.cases ?? [];

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            {projectLabel} · <Link to={base as never} className="text-primary-text">Test plans</Link> / {wasNew ? 'New' : 'Edit'}
          </>
        }
        title={
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>Release</span>
            <input
              aria-label="Release"
              placeholder="x.y"
              value={form.release}
              onChange={(e) => set({ release: e.target.value })}
              className="w-[9ch] min-w-0 rounded-tag border border-dashed border-line-dashed-strong bg-transparent px-2 font-mono text-[24px] text-fg"
            />
            <span aria-hidden="true">·</span>
            <input
              aria-label="Plan name"
              aria-invalid={errors.name !== undefined}
              placeholder="Plan name"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              className="min-w-0 flex-1 basis-[240px] rounded-tag border border-dashed border-line-dashed-strong bg-transparent px-2 text-[24px] font-semibold text-fg"
            />
          </span>
        }
        actions={
          <>
            {notice !== null && !dirty && (
              <span role="status" className="text-sm font-medium text-success">
                {notice}
              </span>
            )}
            <Can permission="plans:write">
              {planId !== undefined && (
                <Button variant="danger-outline" disabled={busy} onClick={() => setDeleteOpen(true)}>
                  Delete
                </Button>
              )}
              <Button disabled={busy} onClick={() => void onSave()}>
                {create.isPending || update.isPending ? 'Saving…' : 'Save plan'}
              </Button>
            </Can>
            <Can permission="runs:execute">
              <Button variant="primary" disabled={busy} onClick={() => void onRun()}>
                {createRun.isPending ? 'Starting…' : 'Run plan now'}
              </Button>
            </Can>
          </>
        }
      />
      {errors.name !== undefined && (
        <p role="alert" className="-mt-3 text-sm text-danger">
          {errors.name}
        </p>
      )}
      {serverError !== null && <Callout tone="danger">{serverError}</Callout>}
      <DeletePlanDialog
        plan={deleteOpen && planId !== undefined ? { id: planId, name: form.name || 'Untitled plan' } : null}
        onOpenChange={setDeleteOpen}
        onDeleted={() => void navigate({ to: `/p/${encodeURIComponent(projectKey)}/plans` as never })}
        onError={setServerError}
      />

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5">
          <Card aria-label="Case selection" className={sectionCls}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[17px] font-semibold text-fg">1 · Which cases</h2>
              <Segmented
                aria-label="Selection mode"
                value={form.selectionKind}
                onChange={(v) => set({ selectionKind: v })}
                options={[
                  { value: 'query', label: 'Saved query' },
                  { value: 'list', label: 'Pick manually' },
                ]}
              />
            </div>
            {form.selectionKind === 'query' ? (
              <Field
                label="Query"
                hint={
                  queryError !== undefined ? (
                    <span role="alert" className="text-danger">
                      {queryError}
                    </span>
                  ) : errors.query !== undefined ? (
                    <span role="alert" className="text-danger">
                      {errors.query}
                    </span>
                  ) : (
                    'Fields: suite, tags, priority, status, owner, type, requirement, learned, lastResult, quarantined. Combine with AND, OR, NOT.'
                  )
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    mono
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={queryError !== undefined || errors.query !== undefined}
                    value={form.query}
                    placeholder="suite:Checkout AND priority<=P2 AND status:ready"
                    onChange={(e) => set({ query: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button size="sm" onClick={() => setPicking(true)}>
                    + Pick cases
                  </Button>
                  <span className="text-[13px] text-secondary">
                    {form.caseIds.length} {form.caseIds.length === 1 ? 'case' : 'cases'} selected
                  </span>
                </div>
                {form.caseIds.length === 0 ? (
                  <EmptyState>No cases picked yet. Use Pick cases, or Add to plan from the test case list.</EmptyState>
                ) : (
                  <ul className="m-0 flex list-none flex-col divide-y divide-divider-row rounded-card border border-line p-0 text-sm">
                    {manualCases.map((c) => (
                      <li key={c.id} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="font-mono text-[13px]">{c.key}</span>
                        <span className="min-w-0 flex-1 truncate">{c.title}</span>
                        <span className="text-xs text-muted">{c.priority}</span>
                        <Button size="sm" aria-label={`Remove ${c.key}`} onClick={() => set({ caseIds: form.caseIds.filter((x) => x !== c.id) })}>
                          Remove
                        </Button>
                      </li>
                    ))}
                    {pv === undefined && <li className="p-3"><Skeleton className="h-6" /></li>}
                  </ul>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2" aria-live="polite" aria-label="Selection preview" aria-busy={previewStale}>
              {pv !== undefined ? (
                <>
                  {previewStale && <span className="text-[13px] text-muted">Updating…</span>}
                  <Chip>
                    {pv.matched} {form.selectionKind === 'list' ? (pv.matched === 1 ? 'case selected' : 'cases selected') : pv.matched === 1 ? 'case matches' : 'cases match'}
                  </Chip>
                  <Chip>{pv.learned} learned · replay</Chip>
                  <Chip tone="warning">{pv.notLearned} not learned · explore (slower)</Chip>
                  <Chip tone="flaky">{pv.quarantined} quarantined · excluded</Chip>
                </>
              ) : preview.isFetching ? (
                <Skeleton className="h-8 w-72" />
              ) : (
                <span className="text-[13px] text-muted">
                  {form.matrix.length === 0 ? 'Tick an environment below to preview matching cases.' : 'Enter a query to preview matching cases.'}
                </span>
              )}
            </div>
          </Card>

          <Card aria-label="Matrix" className={sectionCls}>
            <h2 className="text-[17px] font-semibold text-fg">2 · Where to run</h2>
            {errors.matrix !== undefined && (
              <p role="alert" className="text-sm text-danger">
                {errors.matrix}
              </p>
            )}
            {envs.length === 0 ? (
              <EmptyState action={<LinkButton to={`/p/${encodeURIComponent(projectKey)}/environments`}>Add an environment</LinkButton>}>
                This project has no environments yet.
              </EmptyState>
            ) : (
              <MatrixTable
                envs={envs}
                matrix={form.matrix}
                device={form.mobileDevice}
                onToggle={(envId, col) => set({ matrix: toggleCell(form.matrix, envId, col, form.mobileDevice) })}
                onDevice={(d) => set({ mobileDevice: d, matrix: changeDevice(form.matrix, d) })}
              />
            )}
          </Card>

          <Card aria-label="Execution settings" className={sectionCls}>
            <h2 className="text-[17px] font-semibold text-fg">3 · How to run</h2>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
              <Field label="Mode">
                {(id) => (
                  <Select id={id} value={form.mode} onChange={(e) => set({ mode: e.target.value as PlanForm['mode'] })}>
                    {MODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Retries on failure">
                {(id) => <Input id={id} type="number" min={0} max={3} value={form.retries} onChange={(e) => set({ retries: clampInt(e.target.value, 0, 3, 0) })} />}
              </Field>
              <Field label="Parallel workers">
                {(id) => <Input id={id} type="number" min={1} max={32} value={form.parallelism} onChange={(e) => set({ parallelism: clampInt(e.target.value, 1, 32, 1) })} />}
              </Field>
              <Field label="Run on workers with label" hint="Comma-separated, e.g. gpu, eu. Empty = any worker.">
                {(id) => <Input id={id} value={form.workerLabels} placeholder="any worker" onChange={(e) => set({ workerLabels: e.target.value })} />}
              </Field>
              <Field label="Unattended escalations">
                {(id) => (
                  <Select id={id} value={form.unattended} onChange={(e) => set({ unattended: e.target.value as PlanForm['unattended'] })}>
                    {UNATTENDED_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <Checkbox label="Accessibility scan (axe)" checked={form.checks.a11y} onChange={(e) => set({ checks: { ...form.checks, a11y: e.target.checked } })} />
              <Checkbox label="Fail on console errors" checked={form.checks.consoleErrors} onChange={(e) => set({ checks: { ...form.checks, consoleErrors: e.target.checked } })} />
              <Checkbox label="Visual comparison (later)" checked={false} disabled />
              <Checkbox label="Record video" checked={form.checks.video} onChange={(e) => set({ checks: { ...form.checks, video: e.target.checked } })} />
            </div>
            <ManualAssignments cases={manualCases} assignments={form.assignments} onChange={(assignments) => set({ assignments })} />
          </Card>
        </div>

        <aside aria-label="Schedule and exit criteria" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <Card className="flex flex-col gap-3 p-[18px] text-sm">
            <h2 className="text-[15px] font-semibold text-fg">Triggers</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox label="Schedule" checked={form.scheduleOn} onChange={(e) => set({ scheduleOn: e.target.checked, cron: form.cron === '' ? DEFAULT_CRON : form.cron })} />
              <input
                type="text"
                aria-label="Cron expression"
                aria-invalid={form.scheduleOn && !cron.valid}
                spellCheck={false}
                disabled={!form.scheduleOn}
                value={form.cron}
                onChange={(e) => set({ cron: e.target.value })}
                className="ml-auto min-h-[44px] w-[140px] rounded-control border border-line-input bg-surface px-2 font-mono text-[13px] text-fg disabled:bg-surface-muted"
              />
            </div>
            {form.scheduleOn && (
              <p aria-live="polite" className={cron.valid ? 'text-[13px] text-secondary' : 'text-[13px] text-danger'}>
                {cron.text}
              </p>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fg">On deploy webhook</span>
              {planId === undefined ? (
                <span className="text-xs text-muted">The URL appears after you save the plan.</span>
              ) : (
                <WebhookInfo planId={planId} />
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fg">From CI</span>
              <Link to={'/settings/api-tokens' as never} className="text-[13px] text-primary-text">
                Create an API token in Settings › API tokens
              </Link>
            </div>
            {planId === undefined ? (
              <Checkbox label="Notify a channel on finish (save the plan first)" checked={false} disabled />
            ) : (
              <NotifyOnFinish planId={planId} projectKey={projectKey} />
            )}
          </Card>

          <Card className="flex flex-col gap-2.5 p-[18px] text-sm">
            <h2 className="text-[15px] font-semibold text-fg">Exit criteria</h2>
            {form.exitCriteria.length === 0 && <p className="text-[13px] text-muted">No criteria yet. A run always reports pass or fail per case.</p>}
            {form.exitCriteria.map((c, i) => (
              <CriterionRow
                key={i}
                criterion={c}
                onChange={(next) => set({ exitCriteria: form.exitCriteria.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => set({ exitCriteria: form.exitCriteria.filter((_, j) => j !== i) })}
              />
            ))}
            <DropdownMenu>
              <DropdownTrigger asChild>
                <Button variant="dashed" className="self-start">
                  + Add criterion
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                {CRITERION_TEMPLATES.map((t) => (
                  <DropdownItem key={t.kind} onSelect={() => set({ exitCriteria: [...form.exitCriteria, { kind: t.kind, params: { ...t.params } }] })}>
                    {t.label}
                  </DropdownItem>
                ))}
              </DropdownContent>
            </DropdownMenu>
          </Card>

          <Card aria-label="Estimate" className="flex flex-col gap-1.5 border-dashed p-[18px] text-sm">
            <h2 className="text-[15px] font-semibold text-fg">Estimate</h2>
            {pv !== undefined ? (
              <>
                <div data-testid="estimate-executions">
                  {pv.matched - pv.quarantined} {pv.matched - pv.quarantined === 1 ? 'case' : 'cases'} × {pv.combos.length} {pv.combos.length === 1 ? 'combo' : 'combos'} = {pv.executions}{' '}
                  {pv.executions === 1 ? 'execution' : 'executions'}
                </div>
                <div className="text-secondary">
                  ~{pv.estimateMin} min with {form.parallelism} {form.parallelism === 1 ? 'worker' : 'workers'}
                </div>
                {pv.skippedCombos.length > 0 && (
                  <div className="text-xs text-warning">
                    {pv.skippedCombos.length} matrix {pv.skippedCombos.length === 1 ? 'entry is' : 'entries are'} skipped: {pv.skippedCombos[0]?.reason}
                  </div>
                )}
              </>
            ) : (
              <div className="text-muted">Pick cases and where to run to see an estimate.</div>
            )}
          </Card>
        </aside>
      </div>

      <CasePickerDialog projectKey={projectKey} open={picking} onOpenChange={setPicking} initial={form.caseIds} onConfirm={(ids) => set({ caseIds: ids })} />
    </>
  );
}

function CriterionRow({ criterion, onChange, onRemove }: { criterion: PlanForm['exitCriteria'][number]; onChange: (c: PlanForm['exitCriteria'][number]) => void; onRemove: () => void }) {
  const text = criterionText(criterion);
  const percent = typeof criterion.params['percent'] === 'number' ? (criterion.params['percent'] as number) : 100;
  const percentInput = (
    <input
      type="number"
      min={0}
      max={100}
      aria-label={`${text} — percent`}
      value={percent}
      onChange={(e) => onChange({ ...criterion, params: { ...criterion.params, percent: clampInt(e.target.value, 0, 100, 0) } })}
      className="h-9 w-[64px] rounded-tag border border-line-input bg-surface px-2 font-mono text-[13px]"
    />
  );
  let body: ReactNode;
  if (criterion.kind === 'p0-passed') {
    body = (
      <>
        {percentInput}% of P0 cases passed
      </>
    );
  } else if (criterion.kind === 'pass-rate') {
    body = (
      <>
        ≥ {percentInput}% of P1–P2 passed
      </>
    );
  } else if (criterion.kind === 'no-open-defects') {
    const sev = typeof criterion.params['severity'] === 'string' ? (criterion.params['severity'] as string) : 'S2';
    body = (
      <>
        No open defects ≥
        <select
          aria-label="Defect severity"
          value={sev}
          onChange={(e) => onChange({ ...criterion, params: { ...criterion.params, severity: e.target.value } })}
          className="h-9 rounded-tag border border-line-input bg-surface px-2 text-[13px]"
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </>
    );
  } else {
    body = text;
  }
  return (
    <div className="flex items-center gap-2 rounded-tag bg-surface-subtle px-2.5 py-1.5" role="group" aria-label={text}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{body}</span>
      <Button size="sm" aria-label={`Remove criterion: ${text}`} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

/** Test plan builder (`/p/:key/plans/:planId`, `new` to create). */
export function PlanBuilderPage({ projectKey, planId }: { projectKey: string; planId: string }) {
  const projects = trpc.projects.list.useQuery();
  const envs = trpc.environments.list.useQuery({ projectKey });
  const isNew = planId === 'new';
  const plan = trpc.plans.get.useQuery(planId, { enabled: !isNew, retry: false });
  const projectName = projects.data?.find((p) => p.key === projectKey)?.name;
  const label = projectName !== undefined ? `${projectKey} · ${projectName}` : projectKey;

  if (envs.isLoading || (!isNew && plan.isLoading)) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <PageHeader title="Test plan" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (envs.isError) {
    return (
      <>
        <PageHeader title="Test plan" />
        <Callout tone="danger">Could not load environments: {errorMessage(envs.error)}</Callout>
      </>
    );
  }
  if (!isNew && plan.isError) {
    return (
      <>
        <PageHeader title="Test plan" />
        <Callout tone="danger">Could not load this plan: {errorMessage(plan.error)}</Callout>
        <LinkButton to={`/p/${encodeURIComponent(projectKey)}/plans`}>Back to test plans</LinkButton>
      </>
    );
  }
  const stored = !isNew ? (plan.data as StoredPlan | undefined) : undefined;
  return <PlanBuilder key={stored?.id ?? 'new'} projectKey={projectKey} projectLabel={label} envs={envs.data ?? []} {...(stored !== undefined ? { plan: stored } : {})} />;
}
