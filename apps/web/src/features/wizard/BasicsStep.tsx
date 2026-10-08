import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { BasicsSchema, keyFromName, type BasicsValues } from './model';
import { fieldError, WizardFooter, type StepProps } from './shared';

import { Callout, Card, Field, Input } from '@/components/ui';
import { errorMessage, trpcCode } from '@/lib/errors';
import { zodResolver } from '@/lib/form';
import { trpc } from '@/lib/trpc';

/** Step 1: name, key and base URL. Submitting creates the project (and its `dev` environment) so later steps save incrementally. */
export function BasicsStep({ draft, patch, go, onExit }: StepProps) {
  const created = draft.createdKey !== undefined;
  const utils = trpc.useUtils();
  const create = trpc.projects.create.useMutation();
  const [serverError, setServerError] = useState<string | null>(null);
  const [keyTouched, setKeyTouched] = useState(draft.basics.keyTouched);
  const form = useForm<BasicsValues>({
    resolver: zodResolver(BasicsSchema),
    defaultValues: { name: draft.basics.name, key: draft.basics.key, baseUrl: draft.basics.baseUrl },
  });
  const { errors } = form.formState;

  // Keep the sessionStorage draft in step with the form (the API is never involved until submit).
  useEffect(() => {
    const sub = form.watch((v) => {
      patch({ basics: { name: v.name ?? '', key: v.key ?? '', baseUrl: v.baseUrl ?? '', keyTouched } });
    });
    return () => sub.unsubscribe();
  }, [form, patch, keyTouched]);

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    patch({ basics: { ...values, keyTouched } });
    if (created) {
      go('environments');
      return;
    }
    try {
      const project = await create.mutateAsync(values);
      patch({ basics: { ...values, keyTouched }, createdKey: project.key });
      await utils.projects.list.invalidate();
      go('environments');
    } catch (err) {
      if (trpcCode(err) === 'CONFLICT') form.setError('key', { message: `A project with key ${values.key} already exists` });
      else setServerError(errorMessage(err));
    }
  });

  const nameField = form.register('name', {
    onChange: (e: { target: { value: string } }) => {
      if (!keyTouched) form.setValue('key', keyFromName(e.target.value), { shouldValidate: form.formState.isSubmitted });
    },
  });
  const keyField = form.register('key', {
    onChange: (e: { target: { value: string } }) => {
      setKeyTouched(true);
      form.setValue('key', e.target.value.toUpperCase());
    },
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <Card aria-label="Project basics" className="flex flex-col gap-[18px] p-[22px]">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-fg">Basics</h2>
          <p className="text-sm text-secondary">
            {created
              ? `Project ${draft.createdKey ?? ''} is created. Its key cannot change.`
              : 'Name the project and point it at the app you want to test. The project is created when you continue.'}
          </p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
          <Field label="Project name" hint={fieldError(errors.name?.message)}>
            {(id) => (
              <Input
                id={id}
                autoComplete="off"
                placeholder="Storefront"
                aria-invalid={errors.name !== undefined}
                readOnly={created}
                {...nameField}
              />
            )}
          </Field>
          <Field
            label="Project key"
            hint={fieldError(errors.key?.message) ?? 'Used in case keys such as SHOP-TC-42. Cannot be changed later.'}
          >
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                placeholder="SHOP"
                maxLength={10}
                aria-invalid={errors.key !== undefined}
                readOnly={created}
                {...keyField}
              />
            )}
          </Field>
          <Field label="Base URL" className="sm:col-span-2" hint={fieldError(errors.baseUrl?.message)}>
            {(id) => (
              <Input
                id={id}
                mono
                type="url"
                placeholder="https://shop.example.com"
                aria-invalid={errors.baseUrl !== undefined}
                readOnly={created}
                {...form.register('baseUrl')}
              />
            )}
          </Field>
        </div>
        {serverError !== null && <Callout tone="danger">{serverError}</Callout>}
      </Card>
      <WizardFooter
        onBack={onExit}
        continueLabel="Continue to environments"
        pending={create.isPending}
        pendingLabel="Creating project…"
      />
    </form>
  );
}
