import { Navigate, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';

import { DatasetsCard } from './DatasetsCard';
import { GeneralCard, SafeguardsCard } from './GeneralCard';
import { LoginSetupCard } from './LoginSetupCard';
import { buildPatch, formFromEnv, parseDomains, validateForm, type EnvForm, type FormErrors, type MaskedEnv } from './model';
import { VariablesCard } from './VariablesCard';

import { PageHeader } from '@/components/app/PageHeader';
import { Button, Callout, Card, Dialog, EmptyState, Field, Input, Skeleton, Tabs } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useProjects } from '@/lib/nav-data';
import { Can } from '@/lib/session';
import { trpc } from '@/lib/trpc';

const NO_ERRORS: FormErrors = { variables: {} };

function AddEnvironmentDialog({ projectKey, open, onOpenChange }: { projectKey: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const create = trpc.environments.create.useMutation();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let urlProblem: string | undefined;
  try {
    new URL(baseUrl);
  } catch {
    urlProblem = 'Enter a valid URL';
  }
  const nameProblem = /^[\w][\w.-]*$/.test(name) ? undefined : 'Use letters, digits, dash, dot or underscore';

  const submit = async () => {
    setTouched(true);
    if (nameProblem !== undefined || urlProblem !== undefined) return;
    setError(null);
    try {
      const env = await create.mutateAsync({ projectKey, name, baseUrl, variables: [], allowDomains: [], browsers: [{ browser: 'chromium' }], readOnly: false, requireApprovalFor: ['pay', 'delete', 'send'], locale: 'en-US', timezone: 'UTC' });
      await utils.environments.list.invalidate({ projectKey });
      onOpenChange(false);
      setName('');
      void navigate({ to: `/p/${projectKey}/environments/${env.name}` as never });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const hint = (p: string | undefined) =>
    touched && p !== undefined ? (
      <span role="alert" className="text-danger">
        {p}
      </span>
    ) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add environment"
      description="Where tests run, e.g. staging."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => void submit()}>
            {create.isPending ? 'Adding…' : 'Add environment'}
          </Button>
        </>
      }
    >
      {error !== null && <Callout tone="danger">{error}</Callout>}
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint={hint(nameProblem)}>
          {(id) => <Input id={id} mono autoComplete="off" value={name} placeholder="staging" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Base URL" hint={hint(urlProblem)}>
          {(id) => <Input id={id} mono type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
        </Field>
        <button type="submit" className="sr-only" tabIndex={-1}>
          Add
        </button>
      </form>
    </Dialog>
  );
}

function EnvironmentEditor({
  projectKey,
  env,
  onSaved,
  chrome,
}: {
  projectKey: string;
  env: MaskedEnv;
  onSaved: () => void;
  /** Page header + tabs; receives the Save button so it sits in the header. */
  chrome: (save: ReactNode) => ReactNode;
}) {
  const update = trpc.environments.update.useMutation();
  const [saved, setSaved] = useState(env);
  const [form, setForm] = useState<EnvForm>(() => formFromEnv(env));
  const [domainText, setDomainText] = useState('');
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const effective: EnvForm = { ...form, allowDomains: [...new Set([...form.allowDomains, ...parseDomains(domainText)])] };
  const patch = buildPatch(saved, effective);
  const dirty = Object.keys(patch).length > 0;
  const change = (p: Partial<EnvForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setNotice(null);
  };

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async () => {
    const check = validateForm(effective);
    setErrors(check.errors);
    if (!check.ok || !dirty) return;
    setServerError(null);
    try {
      const next = await update.mutateAsync({ id: saved.id, patch: patch as never });
      setSaved(next);
      setForm(formFromEnv(next));
      setDomainText('');
      setNotice('Changes saved');
      onSaved();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  };

  const readOnlyEnv = saved.readOnly;
  const saveButton = (
    <>
      {notice !== null && (
        <span role="status" className="text-sm font-medium text-success">
          {notice}
        </span>
      )}
      <Can permission="projects:manage">
        <Button variant="primary" disabled={!dirty || update.isPending} onClick={() => void save()}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </Can>
    </>
  );
  return (
    <>
      {chrome(saveButton)}
      {serverError !== null && <Callout tone="danger">{serverError}</Callout>}
      {readOnlyEnv && <Callout tone="warning">This environment is read-only: form submits are blocked and runs cannot change data.</Callout>}
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          <GeneralCard form={form} errors={errors} domainText={domainText} onDomainText={setDomainText} onChange={change} />
          <VariablesCard envId={saved.id} rows={form.variables} errors={errors.variables} onChange={(variables) => change({ variables })} />
          <DatasetsCard projectKey={projectKey} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <LoginSetupCard envId={saved.id} />
          <Card aria-label="Mailbox" className="flex flex-col gap-2.5 p-[18px] text-sm">
            <h2 className="text-[15px] font-semibold text-fg">Test mailbox</h2>
            <div>
              Mailpit · <span className="font-mono text-[13px]">localhost:8025</span>
            </div>
            <div className="text-[13px] text-strong-2">For sign-up links, OTP codes and order emails.</div>
          </Card>
          <SafeguardsCard form={form} onChange={change} />
        </aside>
      </div>
    </>
  );
}

/** Environments screen (`/p/:key/environments/:env`): tabs per environment, general settings, variables, data sets, logins, safeguards. */
export function EnvironmentsPage({ projectKey, envName }: { projectKey: string; envName?: string }) {
  const utils = trpc.useUtils();
  const projectName = useProjects().data?.find((p) => p.key === projectKey)?.name;
  const list = trpc.environments.list.useQuery({ projectKey });
  const [adding, setAdding] = useState(false);

  const envs = list.data ?? [];
  const current = envName !== undefined ? envs.find((e) => e.name === envName) : undefined;
  const chrome = (save: ReactNode) => (
    <>
      <PageHeader
        eyebrow={projectName !== undefined ? `${projectKey} · ${projectName}` : projectKey}
        title="Environments"
        actions={
          <>
            <Can permission="projects:manage">
              <Button onClick={() => setAdding(true)}>+ Add environment</Button>
            </Can>
            {save}
          </>
        }
      />
      {envs.length > 0 && (
        <Tabs
          aria-label="Environment"
          items={envs.map((e) => ({
            to: `/p/${projectKey}/environments/${e.name}`,
            label: (
              <span>
                {e.name}
                {e.readOnly && <span className="ml-1.5 text-xs text-danger">read-only</span>}
              </span>
            ),
          }))}
        />
      )}
    </>
  );
  const idleSave = (
    <Button variant="primary" disabled>
      Save changes
    </Button>
  );

  let body;
  if (list.isLoading) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  } else if (list.isError) {
    body = <Callout tone="danger">Could not load environments: {errorMessage(list.error)}</Callout>;
  } else if (envs.length === 0) {
    body = <EmptyState>No environments yet. Add one to start running tests.</EmptyState>;
  } else if (envName === undefined) {
    body = <Navigate to={`/p/${projectKey}/environments/${envs[0]?.name ?? ''}` as never} replace />;
  } else if (current === undefined) {
    body = <Callout tone="danger">No environment named “{envName}”. Pick one of the tabs above.</Callout>;
  } else {
    body = (
      <EnvironmentEditor
        key={current.id}
        projectKey={projectKey}
        env={current}
        onSaved={() => void utils.environments.list.invalidate({ projectKey })}
        chrome={chrome}
      />
    );
  }

  return (
    <>
      {current !== undefined && !list.isLoading && !list.isError ? (
        body
      ) : (
        <>
          {chrome(idleSave)}
          {body}
        </>
      )}
      <AddEnvironmentDialog projectKey={projectKey} open={adding} onOpenChange={setAdding} />
    </>
  );
}
