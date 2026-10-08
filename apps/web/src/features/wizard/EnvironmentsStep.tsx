import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';

import { EnvironmentsSchema, type EnvironmentsValues, type EnvRow } from './model';
import { fieldError, WizardFooter, type StepProps } from './shared';

import { Button, Callout, Card, Field, Input, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { zodResolver } from '@/lib/form';
import { trpc } from '@/lib/trpc';

/** Step 2: editable environment rows. Saved rows are updated, new rows created and removed rows deleted on continue. */
export function EnvironmentsStep(props: StepProps) {
  const projectKey = props.draft.createdKey ?? '';
  const list = trpc.environments.list.useQuery({ projectKey }, { enabled: projectKey !== '' });
  if (list.isLoading) {
    return (
      <Card aria-label="Environments" className="flex flex-col gap-3 p-[22px]" aria-busy="true">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </Card>
    );
  }
  const saved: EnvRow[] = (list.data ?? []).map((e) => ({ envId: e.id, name: e.name, baseUrl: e.baseUrl }));
  return <EnvironmentsForm {...props} projectKey={projectKey} saved={saved} loadError={list.isError ? errorMessage(list.error) : null} />;
}

function EnvironmentsForm({
  draft,
  patch,
  go,
  projectKey,
  saved,
  loadError,
}: StepProps & { projectKey: string; saved: EnvRow[]; loadError: string | null }) {
  const utils = trpc.useUtils();
  const create = trpc.environments.create.useMutation();
  const update = trpc.environments.update.useMutation();
  const remove = trpc.environments.delete.useMutation();
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);

  const initial: EnvRow[] =
    draft.envRows ??
    (saved.length > 0 ? saved : [{ name: 'dev', baseUrl: draft.basics.baseUrl }]);
  const form = useForm<EnvironmentsValues>({
    resolver: zodResolver(EnvironmentsSchema),
    defaultValues: { rows: initial },
  });
  const { fields, append, remove: removeRow } = useFieldArray({ control: form.control, name: 'rows' });
  const errors = form.formState.errors;

  useEffect(() => {
    const sub = form.watch((v) => {
      patch({ envRows: (v.rows ?? []).map((r) => ({ ...(r?.envId ? { envId: r.envId } : {}), name: r?.name ?? '', baseUrl: r?.baseUrl ?? '' })) });
    });
    return () => sub.unsubscribe();
  }, [form, patch]);

  const onSubmit = form.handleSubmit(async ({ rows }) => {
    setServerError(null);
    setSaving(true);
    try {
      const next: EnvRow[] = [];
      for (const row of rows) {
        const before = saved.find((s) => s.envId === row.envId);
        if (row.envId === undefined || before === undefined) {
          const env = await create.mutateAsync({ projectKey, name: row.name, baseUrl: row.baseUrl });
          next.push({ envId: env.id, name: env.name, baseUrl: env.baseUrl });
        } else {
          if (before.name !== row.name || before.baseUrl !== row.baseUrl) {
            await update.mutateAsync({ id: row.envId, patch: { name: row.name, baseUrl: row.baseUrl } });
          }
          next.push(row);
        }
      }
      for (const id of removed) {
        if (saved.some((s) => s.envId === id)) await remove.mutateAsync({ id });
      }
      await utils.environments.list.invalidate({ projectKey });
      patch({ envRows: next });
      go('models');
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <Card aria-label="Environments" className="flex flex-col gap-[18px] p-[22px]">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-fg">Environments</h2>
          <p className="text-sm text-secondary">Where tests run. Add staging or production later from Environments.</p>
        </div>
        {loadError !== null && <Callout tone="danger">Could not load saved environments: {loadError}</Callout>}
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {fields.map((f, i) => (
            <li key={f.id} className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] items-start gap-3 sm:grid-cols-[1fr_2fr_auto]">
              <Field label={`Environment ${i + 1} name`} hint={fieldError(errors.rows?.[i]?.name?.message)}>
                {(id) => <Input id={id} mono autoComplete="off" aria-invalid={errors.rows?.[i]?.name !== undefined} {...form.register(`rows.${i}.name`)} />}
              </Field>
              <Field label={`Environment ${i + 1} base URL`} hint={fieldError(errors.rows?.[i]?.baseUrl?.message)}>
                {(id) => (
                  <Input
                    id={id}
                    mono
                    type="url"
                    aria-invalid={errors.rows?.[i]?.baseUrl !== undefined}
                    {...form.register(`rows.${i}.baseUrl`)}
                  />
                )}
              </Field>
              <div className="sm:pt-[25px]">
                <Button
                  variant="secondary"
                  disabled={fields.length === 1}
                  aria-label={`Remove environment ${i + 1}`}
                  onClick={() => {
                    const id = form.getValues(`rows.${i}.envId`);
                    if (id !== undefined) setRemoved((r) => [...r, id]);
                    removeRow(i);
                  }}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {errors.rows?.root?.message !== undefined && <span role="alert" className="text-sm text-danger">{errors.rows.root.message}</span>}
        <div>
          <Button variant="dashed" onClick={() => append({ name: '', baseUrl: '' })}>
            + Add environment
          </Button>
        </div>
        {serverError !== null && <Callout tone="danger">{serverError}</Callout>}
      </Card>
      <WizardFooter onBack={() => go('basics')} continueLabel="Continue to models" pending={saving} />
    </form>
  );
}
