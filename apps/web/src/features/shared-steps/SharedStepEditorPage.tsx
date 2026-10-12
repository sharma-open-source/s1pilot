import type { Step } from '@s1pilot/domain';
import { Link, useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { newUid, type DraftStep } from '../case-editor/model';
import { SharedStepPicker } from '../case-editor/SharedStepPicker';
import { StepGrid } from '../case-editor/StepGrid';
import { StepGuide } from '../case-editor/StepGuide';

import { DeleteSharedStepDialog } from './DeleteSharedStepDialog';
import { paramHints, paramsError, parseParams, usageLines, type SharedStepUsage } from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb, Button, Callout, Card, Dialog, Field, Input, LinkButton, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

interface Form {
  name: string;
  params: string;
  steps: DraftStep[];
}

const EMPTY_USAGE: SharedStepUsage = { steps: [], preconditions: [], flows: [], logins: [] };

function toForm(s: { name: string; params: string[]; steps: Step[] }): Form {
  return { name: s.name, params: s.params.join(', '), steps: s.steps.map((st) => ({ ...st, assert: [...st.assert], inputs: [...st.inputs], uid: newUid() })) };
}

/** Steps as sent to the server (client row ids and empty expected text dropped). */
function toSteps(steps: DraftStep[]): Step[] {
  return steps.map(({ uid, ...s }) => {
    void uid;
    const expected = s.expected?.trim();
    return {
      action: s.action,
      ...(expected ? { expected } : {}),
      assert: s.assert,
      inputs: s.inputs,
      ...(s.sharedStepId !== undefined ? { sharedStepId: s.sharedStepId } : {}),
      ...(s.args !== undefined ? { args: s.args } : {}),
    };
  });
}

const snapshot = (f: Form) => JSON.stringify({ name: f.name.trim(), params: parseParams(f.params), steps: toSteps(f.steps) });

interface SharedStepEditorPageProps {
  projectKey: string;
  /** Shared step id, or `new`. */
  id: string;
  navigate: (to: string) => void;
}

/** Shared step editor (`/p/:key/library/shared-steps/:id`, `new` creates one): name, parameters and steps. */
export function SharedStepEditorPage(props: SharedStepEditorPageProps) {
  return <SharedStepEditor key={`${props.projectKey}/${props.id}`} {...props} />;
}

function SharedStepEditor({ projectKey, id, navigate }: SharedStepEditorPageProps) {
  const isNew = id === 'new';
  const utils = trpc.useUtils();
  const query = trpc.sharedSteps.get.useQuery({ id }, { enabled: !isNew });
  const list = trpc.sharedSteps.list.useQuery({ projectKey });
  const create = trpc.sharedSteps.create.useMutation();
  const update = trpc.sharedSteps.update.useMutation();
  const del = trpc.sharedSteps.delete.useMutation();

  const [form, setForm] = useState<Form | null>(isNew ? { name: '', params: '', steps: [{ uid: newUid(), action: '', assert: [], inputs: [] }] } : null);
  /** Snapshot of the stored version; `null` while creating. */
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const data = query.data;
  useEffect(() => {
    if (data && form === null) {
      const f = toForm(data);
      setForm(f);
      setSaved(snapshot(f));
    }
  }, [data, form]);

  const dirty =
    form !== null &&
    (saved === null ? form.name.trim() !== '' || form.params.trim() !== '' || form.steps.some((s) => s.action.trim() !== '') : snapshot(form) !== saved);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current,
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  });

  const base = `/p/${encodeURIComponent(projectKey)}`;
  const listHref = `${base}/library/shared-steps`;

  if (!isNew && query.isError) {
    return (
      <>
        <PageHeader eyebrow={<Breadcrumb items={[{ label: 'Shared steps & flows', to: listHref }]} />} title="Shared step" />
        <Callout tone="danger">Could not load this shared step: {errorMessage(query.error)}</Callout>
      </>
    );
  }
  if (form === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <PageHeader eyebrow={<Breadcrumb items={[{ label: 'Shared steps & flows', to: listHref }]} />} title="Shared step" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const params = parseParams(form.params);
  const hints = paramHints(params, form.steps);
  const usage = data?.usage ?? EMPTY_USAGE;
  const shared = (list.data ?? []).filter((s) => s.id !== id).map((s) => ({ id: s.id, name: s.name, params: s.params, usageCount: s.usageCount }));
  const patch = (change: Partial<Form>) => setForm((f) => (f ? { ...f, ...change } : f));

  const validate = (): string | null => {
    if (form.name.trim() === '') return 'Give the shared step a name.';
    const pe = paramsError(params);
    if (pe !== null) return pe;
    if (form.steps.length === 0) return 'A shared step needs at least one step.';
    const empty = form.steps.findIndex((s) => s.sharedStepId === undefined && s.action.trim() === '');
    if (empty >= 0) return `Step ${empty + 1} has no action.`;
    return null;
  };

  const save = async () => {
    const problem = validate();
    setNotice(null);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    const body = { name: form.name.trim(), params, steps: toSteps(form.steps) };
    try {
      if (isNew) {
        const created = await create.mutateAsync({ projectKey, ...body });
        dirtyRef.current = false;
        void utils.sharedSteps.list.invalidate();
        navigate(`${listHref}/${encodeURIComponent(created.id)}`);
        return;
      }
      await update.mutateAsync({ id, ...body });
      setSaved(snapshot(form));
      setNotice(
        data && data.name !== body.name && usageLines(usage).length > 0
          ? `Saved. References to “${data.name}” now use “${body.name}”.`
          : 'Saved. Every test case that uses this shared step runs the new steps.',
      );
      await Promise.all([utils.sharedSteps.invalidate(), utils.cases.invalidate()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const busy = create.isPending || update.isPending;
  const title = isNew ? 'New shared step' : form.name.trim() || (data?.name ?? 'Shared step');
  const flowIds = new Map((list.data ?? []).map((s) => [s.name, s.id]));

  return (
    <>
      <PageHeader
        eyebrow={
          <Breadcrumb
            items={[
              { label: 'Test cases', to: `${base}/cases` },
              { label: 'Library' },
              { label: 'Shared steps & flows', to: listHref },
              { label: isNew ? 'New' : (data?.name ?? '') },
            ]}
          />
        }
        title={title}
        actions={
          <>
            <LinkButton to={listHref} variant="secondary">
              Back to shared steps
            </LinkButton>
            {!isNew && (
              <Button variant="danger-outline" disabled={busy || del.isPending} onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            )}
            <Button variant="primary" disabled={busy || (!isNew && !dirty)} onClick={() => void save()}>
              {busy ? 'Saving…' : isNew ? 'Create shared step' : 'Save'}
            </Button>
          </>
        }
      />
      {error !== null && <Callout tone="danger">{error}</Callout>}
      {notice !== null && (
        <div role="status">
          <Callout tone="success">{notice}</Callout>
        </div>
      )}
      {!isNew && dirty && (
        <p role="status" className="m-0 text-[13px] text-secondary">
          Unsaved changes
        </p>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Shared step" className="flex min-w-0 flex-[999_1_600px] flex-col gap-3">
          <Card aria-label="Name and parameters" className="flex flex-col gap-4 p-[18px]">
            <Field label="Name" hint="Shown in test cases and used by YAML (flow: name) and preconditions.">
              {(fid) => <Input id={fid} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Log in as role" autoFocus={isNew} />}
            </Field>
            <Field label="Parameters (optional)" hint="Comma-separated names. Write them as {name} in the steps; each test case gives its own value.">
              {(fid) => <Input id={fid} mono value={form.params} onChange={(e) => patch({ params: e.target.value })} placeholder="role, password" autoComplete="off" />}
            </Field>
          </Card>
          <StepGrid
            steps={form.steps}
            params={params}
            shared={shared}
            onChange={(steps) => patch({ steps })}
            onInsertShared={() => setPickerOpen(true)}
            recordable={false}
            caption="Shared steps"
            emptyText="No steps yet. A shared step needs at least one step."
          />
          {hints.map((h) => (
            <Callout key={h} tone="warning">
              {h}
            </Callout>
          ))}
          <StepGuide defaultOpen={isNew} />
        </section>

        <aside aria-label="Shared step usage" className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <Card aria-label="Used by" className="flex flex-col gap-2.5 p-[18px] text-sm">
            <h2 className="text-[15px] font-semibold">Used by</h2>
            {isNew || usageLines(usage).length === 0 ? (
              <p className="m-0 text-secondary">Not used yet.</p>
            ) : (
              <dl className="m-0 flex flex-col gap-2">
                {usageLines(usage).map((l) => (
                  <div key={l.label}>
                    <dt className="text-[13px] text-secondary">{l.label}</dt>
                    <dd className="m-0 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[13px]">
                      {l.items.map((item) => {
                        const caseLink = l.label.endsWith('test cases');
                        const flowId = l.label === 'Other shared steps' ? flowIds.get(item) : undefined;
                        const to = caseLink ? `${base}/cases/${encodeURIComponent(item)}` : flowId !== undefined ? `${listHref}/${encodeURIComponent(flowId)}` : undefined;
                        return to !== undefined ? (
                          <Link key={item} to={to as never} className="text-primary-text">
                            {item}
                          </Link>
                        ) : (
                          <span key={item}>{item}</span>
                        );
                      })}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
          <Card aria-label="How to use it" className="flex flex-col gap-2 p-[18px] text-sm">
            <h2 className="text-[15px] font-semibold">How to use it</h2>
            <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-secondary">
              <li>
                In a test case, click <strong className="font-medium text-fg">+ Insert shared step</strong> or type <code className="font-mono">@</code> in an action, then fill in the parameters.
              </li>
              <li>
                As a precondition: add <code className="font-mono">flow: {form.name.trim() || 'name'}</code> above a case’s steps. It runs before step 1; if it fails the case is blocked.
              </li>
              <li>As an environment login: pick it in the environment’s login setup.</li>
              <li>Changes here apply to every case that uses it on its next run.</li>
            </ul>
          </Card>
        </aside>
      </div>

      <SharedStepPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projectKey={projectKey}
        {...(isNew ? {} : { excludeId: id })}
        onPick={(s) =>
          patch({
            steps: [...form.steps, { uid: newUid(), action: `Run flow ${s.name}`, sharedStepId: s.id, args: Object.fromEntries(s.params.map((p) => [p, ''])), assert: [], inputs: [] }],
          })
        }
      />

      {!isNew && (
        <DeleteSharedStepDialog
          target={deleteOpen && data ? { name: data.name, usage } : null}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() =>
            del.mutate(
              { id },
              {
                onSuccess: () => {
                  dirtyRef.current = false;
                  void utils.sharedSteps.list.invalidate();
                  navigate(listHref);
                },
                onError: (e) => setError(errorMessage(e)),
              },
            )
          }
        />
      )}

      <Dialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
        title="Discard unsaved changes?"
        description="You have edits to this shared step that are not saved. Leaving now discards them."
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
