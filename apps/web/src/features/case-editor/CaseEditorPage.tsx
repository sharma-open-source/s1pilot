import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { RecorderDialog } from '../recorder/RecorderDialog';

import { CaseAside } from './CaseAside';
import { ConflictDialog } from './ConflictDialog';
import { HistoryTab } from './HistoryTab';
import { LearnedTab } from './LearnedTab';
import {
  isDirty,
  paramNames,
  toDraft,
  toPatch,
  newUid,
  type CaseContent,
  type Draft,
  type DraftStep,
} from './model';
import { ParametersTab } from './ParametersTab';
import { PreconditionStrip } from './PreconditionStrip';
import { ResultsTab } from './ResultsTab';
import { SharedStepPicker } from './SharedStepPicker';
import { StepGrid } from './StepGrid';
import { StepGuide } from './StepGuide';
import { YamlTab } from './YamlTab';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb, Button, Callout, Dialog, Select, Skeleton, Tabs } from '@/components/ui';
import { errorMessage, trpcCode } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

export const CASE_TABS = ['steps', 'parameters', 'learned', 'yaml', 'history', 'results'] as const;
export type CaseTab = (typeof CASE_TABS)[number];

/** Maps the optional `:tab` route segment to a known tab (default `steps`). */
export function parseTab(raw: string | undefined): CaseTab {
  return (CASE_TABS as readonly string[]).includes(raw ?? '') ? (raw as CaseTab) : 'steps';
}

const BROWSERS = [
  { value: 'chromium', label: 'Chromium' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'webkit', label: 'WebKit' },
] as const;

type CaseRecord = RouterOutputs['cases']['get'];
type Base = CaseContent & { version: number };

function baseOf(c: CaseContent & { version: number }): Base {
  return {
    title: c.title,
    priority: c.priority,
    type: c.type,
    status: c.status,
    tags: c.tags,
    requirements: c.requirements,
    preconditions: c.preconditions,
    parameters: c.parameters,
    steps: c.steps,
    version: c.version,
  };
}

interface CaseEditorPageProps {
  projectKey: string;
  caseKey: string;
  /** Raw `:tab` route segment. */
  tab?: string | undefined;
  /** In-app navigation by path (used after "Run now"). */
  navigate: (to: string) => void;
}

/** Test case editor (`/p/:key/cases/:caseKey/:tab?`): header, tabs, step grid and details aside. */
export function CaseEditorPage(props: CaseEditorPageProps) {
  // Remount per case so draft state never leaks between cases.
  return <CaseEditor key={`${props.projectKey}/${props.caseKey}`} {...props} />;
}

function CaseEditor({ projectKey, caseKey, tab: rawTab, navigate }: CaseEditorPageProps) {
  const tab = parseTab(rawTab);
  const utils = trpc.useUtils();
  const query = trpc.cases.get.useQuery({ key: caseKey });
  const envs = trpc.environments.list.useQuery({ projectKey });
  const sharedList = trpc.sharedSteps.list.useQuery({ projectKey });
  const update = trpc.cases.update.useMutation();
  const createRun = trpc.runs.create.useMutation();

  const [base, setBase] = useState<Base | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<CaseRecord | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [runOn, setRunOn] = useState('');

  const dirty = base !== null && draft !== null && isDirty(base, draft);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Initialise from the server, and follow external changes while there are no local edits.
  const data = query.data;
  const baseRef = useRef<Base | null>(null);
  baseRef.current = base;
  useEffect(() => {
    if (!data) return;
    const current = baseRef.current;
    // `>`: a refetch that is still older than what we just saved must not roll the editor back.
    if (current === null || (data.version > current.version && !dirtyRef.current)) {
      setBase(baseOf(data));
      setDraft(toDraft(data));
    }
  }, [data]);

  const patchDraft = useCallback((change: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...change } : d)), []);
  const setSteps = useCallback((steps: DraftStep[]) => patchDraft({ steps }), [patchDraft]);

  // Unsaved-changes guard: in-app navigation away from this case, and tab close / reload.
  const caseRoot = (p: string) => p.split('/').slice(0, 5).join('/');
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirtyRef.current && caseRoot(current.pathname) !== caseRoot(next.pathname),
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  });

  const validate = (d: Draft): string | null => {
    if (d.title.trim() === '') return 'Give the test case a title.';
    if (d.steps.length === 0) return 'A test case needs at least one step.';
    const empty = d.steps.findIndex((s) => s.sharedStepId === undefined && s.action.trim() === '');
    if (empty >= 0) return `Step ${empty + 1} has no action.`;
    return null;
  };

  /** Saves the draft; `expectedVersion` overrides the base version (Overwrite). Resolves to whether it was saved. */
  const save = async (expectedVersion?: number): Promise<boolean> => {
    if (!base || !draft) return false;
    const problem = validate(draft);
    if (problem !== null) {
      setSaveError(problem);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const patch = toPatch(draft);
      const saved = await update.mutateAsync({ key: caseKey, expectedVersion: expectedVersion ?? base.version, patch });
      const next: Base = { ...patch, version: saved.version };
      dirtyRef.current = false;
      setBase(next);
      setConflict(null);
      await utils.cases.invalidate();
      return true;
    } catch (err) {
      if (trpcCode(err) === 'CONFLICT') {
        try {
          setConflict(await utils.cases.get.fetch({ key: caseKey }, { staleTime: 0 }));
        } catch (inner) {
          setSaveError(errorMessage(inner));
        }
      } else {
        setSaveError(errorMessage(err));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirtyRef.current) void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const runTargets = useMemo(
    () => (envs.data ?? []).flatMap((env) => BROWSERS.map((b) => ({ value: `${env.id}|${b.value}`, label: `${env.name} · ${b.label}`, envName: env.name, browser: b.value }))),
    [envs.data],
  );
  const runValue = runOn !== '' ? runOn : (runTargets[0]?.value ?? '');

  const runNow = async () => {
    const target = runTargets.find((t) => t.value === runValue);
    if (!target) return;
    if (dirtyRef.current && !(await save())) return;
    try {
      const run = await createRun.mutateAsync({ projectKey, caseKeys: [caseKey], environment: target.envName, browser: target.browser, attended: true });
      navigate(`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(run.id)}/live`);
    } catch (err) {
      setSaveError(errorMessage(err));
    }
  };

  /** Saves pending edits, then records new steps after the last one. */
  const recordFromHere = async () => {
    if (dirtyRef.current && !(await save())) return;
    setRecordOpen(true);
  };

  const reloadFromServer = (c: CaseRecord) => {
    setBase(baseOf(c));
    setDraft(toDraft(c));
    setConflict(null);
    setSaveError(null);
    void utils.cases.invalidate();
  };

  if (query.isError) {
    return (
      <>
        <PageHeader eyebrow={<span className="font-mono">{caseKey}</span>} title="Test case" />
        <Callout tone="danger">
          Could not load {caseKey}: {errorMessage(query.error)}
        </Callout>
      </>
    );
  }
  if (!data || !base || !draft) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <PageHeader eyebrow={<span className="font-mono">{caseKey}</span>} title="Test case" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const root = `/p/${encodeURIComponent(projectKey)}/cases/${encodeURIComponent(caseKey)}`;
  const names = paramNames(draft.parameters);
  const shared = (sharedList.data ?? []).map((s) => ({ id: s.id, name: s.name, params: s.params, usageCount: s.usageCount }));

  const insertShared = (s: { id: string; name: string; params: string[] }) =>
    setSteps([
      ...draft.steps,
      { uid: newUid(), action: `Run flow ${s.name}`, sharedStepId: s.id, args: Object.fromEntries(s.params.map((p) => [p, ''])), assert: [], inputs: [] },
    ]);

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_400px] flex-col gap-1.5">
          <Breadcrumb
            items={[
              { label: 'Test cases', to: `/p/${encodeURIComponent(projectKey)}/cases` },
              ...data.suitePath.map((s) => ({ label: s.name })),
              {
                label: (
                  <>
                    <span className="font-mono">{data.key}</span> · v{base.version}
                  </>
                ),
              },
            ]}
          />
          <label className="flex flex-col">
            <span className="sr-only">Title</span>
            <input
              type="text"
              value={draft.title}
              onChange={(e) => patchDraft({ title: e.target.value })}
              className="-ml-1.5 rounded-tag border border-transparent bg-transparent px-1.5 py-1 text-[26px] font-semibold text-fg hover:border-line-input focus:border-primary"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 text-sm">
            Run on
            <Select value={runValue} onChange={(e) => setRunOn(e.target.value)} disabled={runTargets.length === 0} className="w-auto">
              {runTargets.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </label>
          <Button variant="secondary" disabled={runTargets.length === 0 || saving || createRun.isPending} onClick={() => void runNow()}>
            Run now
          </Button>
          <Button variant="primary" disabled={saving || !dirty} onClick={() => void save()} title="Ctrl/Cmd+S">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      {saveError !== null && <Callout tone="danger">{saveError}</Callout>}
      {dirty && (
        <p role="status" className="m-0 text-[13px] text-secondary">
          Unsaved changes
        </p>
      )}

      <Tabs
        aria-label="Case sections"
        items={[
          { label: 'Steps', to: `${root}/steps` },
          { label: names.length > 0 ? `Parameters · ${names.length}` : 'Parameters', to: `${root}/parameters` },
          { label: 'Learned script', to: `${root}/learned` },
          { label: 'YAML', to: `${root}/yaml` },
          { label: 'History', to: `${root}/history` },
          { label: 'Results', to: `${root}/results` },
        ]}
      />

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label={tab === 'steps' ? 'Steps' : 'Case content'} className="flex min-w-0 flex-[999_1_600px] flex-col gap-3">
          {tab === 'steps' && (
            <>
              <PreconditionStrip preconditions={draft.preconditions} onChange={(preconditions) => patchDraft({ preconditions })} />
              <StepGrid
                steps={draft.steps}
                params={names}
                shared={shared}
                onChange={setSteps}
                onInsertShared={() => setPickerOpen(true)}
                onRecord={() => void recordFromHere()}
              />
              <StepGuide defaultOpen={draft.steps.every((s) => s.action.trim() === '')} />
            </>
          )}
          {tab === 'parameters' && <ParametersTab parameters={draft.parameters} onChange={(parameters) => patchDraft({ parameters })} />}
          {tab === 'learned' && <LearnedTab learned={data.learned} stepCount={base.steps.length} />}
          {tab === 'yaml' && (
            <YamlTab
              caseKey={caseKey}
              hasUnsavedEdits={dirty}
              onApplied={(c) => {
                reloadFromServer({ ...data, ...c, version: c.version });
              }}
            />
          )}
          {tab === 'history' && <HistoryTab caseKey={caseKey} />}
          {tab === 'results' && <ResultsTab projectKey={projectKey} caseKey={caseKey} />}
        </section>
        <CaseAside projectKey={projectKey} caseKey={caseKey} draft={draft} learned={data.learned} onChange={patchDraft} parametersHref={`${root}/parameters`} />
      </div>

      <RecorderDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        projectKey={projectKey}
        caseKey={caseKey}
        fromStep={base.steps.length}
        onSaved={() => void utils.cases.invalidate()}
      />

      <SharedStepPicker open={pickerOpen} onOpenChange={setPickerOpen} projectKey={projectKey} onPick={insertShared} />

      <ConflictDialog
        open={conflict !== null}
        serverVersion={conflict?.version ?? base.version}
        baseVersion={base.version}
        serverSteps={conflict?.steps ?? []}
        draftSteps={draft.steps}
        busy={saving}
        onCancel={() => setConflict(null)}
        onReload={() => conflict && reloadFromServer(conflict)}
        onOverwrite={() => conflict && void save(conflict.version)}
      />

      <Dialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
        title="Discard unsaved changes?"
        description="You have edits to this test case that are not saved. Leaving now discards them."
        footer={
          <>
            <Button variant="secondary" onClick={() => blocker.status === 'blocked' && blocker.reset()}>
              Keep editing
            </Button>
            <Button variant="danger-outline" onClick={() => blocker.status === 'blocked' && blocker.proceed()}>
              Discard changes
            </Button>
          </>
        }
      />
    </>
  );
}
