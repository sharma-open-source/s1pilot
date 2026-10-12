import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  actBounds,
  apiKeyRefFrom,
  constrainThresholds,
  escalateBounds,
  ModelsSchema,
  S1_ADAPTERS,
  type ModelsValues,
} from './model';
import { fieldError, ResultLine, WizardFooter, type StepProps } from './shared';

import { CapabilityGrid } from '@/components/app/CapabilityGrid';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Field,
  Input,
  Pill,
  Range,
  Select,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { zodResolver } from '@/lib/form';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type ProbeResult = RouterOutputs['models']['probe'];

interface ProbeState {
  state: 'idle' | 'pending' | 'success' | 'error';
  result?: ProbeResult;
  error?: string;
}

/** Runs `models.probe` through the vanilla client so the API key never enters the react-query cache. */
function useProbe() {
  const utils = trpc.useUtils();
  const [probe, setProbe] = useState<ProbeState>({ state: 'idle' });
  const run = async (input: {
    baseUrl: string;
    model: string;
    adapter: ModelsValues['s1']['adapter'] | 'openai-chat';
    apiKey: string;
  }) => {
    setProbe({ state: 'pending' });
    const ref = apiKeyRefFrom(input.apiKey);
    const pastedKey =
      input.apiKey.trim() !== '' && ref === undefined ? input.apiKey.trim() : undefined;
    try {
      const result = await utils.client.models.probe.mutate({
        baseUrl: input.baseUrl,
        adapter: input.adapter,
        ...(input.model !== '' ? { model: input.model } : {}),
        ...(pastedKey !== undefined ? { apiKey: pastedKey } : {}),
        ...(ref !== undefined ? { apiKeyRef: ref } : {}),
        timeoutMs: 30_000,
      });
      setProbe(
        result.ok
          ? { state: 'success', result }
          : { state: 'error', result, error: result.error ?? 'Could not connect' },
      );
    } catch (err) {
      setProbe({ state: 'error', error: errorMessage(err) });
    }
  };
  return [probe, run, () => setProbe({ state: 'idle' })] as const;
}

function ProbeLine({ probe, label }: { probe: ProbeState; label: string }) {
  return (
    <ResultLine
      state={probe.state}
      progress={`Testing ${label}…`}
      success={`Connected · decision returned in ${probe.result?.latencyMs.p50 ?? 0} ms`}
      error={probe.error ?? 'Could not connect'}
    />
  );
}

/** Step 3: System 1 / System 2 endpoints, confidence policy and data policy. */
export function ModelsStep({ draft, patch, go }: StepProps) {
  const projectKey = draft.createdKey ?? '';
  const utils = trpc.useUtils();
  const [s1Probe, runS1Probe, resetS1Probe] = useProbe();
  const [s2Probe, runS2Probe, resetS2Probe] = useProbe();
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const form = useForm<ModelsValues>({
    resolver: zodResolver(ModelsSchema),
    defaultValues: {
      ...draft.models,
      s1: { ...draft.models.s1, apiKey: '' },
      s2: { ...draft.models.s2, apiKey: '' },
    },
  });
  const errors = form.formState.errors;
  const act = form.watch('act');
  const escalate = form.watch('escalate');
  const sendPageText = form.watch('sendPageText');
  const sendScreenshots = form.watch('sendScreenshots');
  const dual = form.watch('dualOrderSensitive');

  // Persist everything except API keys.
  useEffect(() => {
    const sub = form.watch((v) => {
      const { s1, s2, ...rest } = v as ModelsValues;
      patch({
        models: {
          ...rest,
          s1: { adapter: s1.adapter, baseUrl: s1.baseUrl, model: s1.model },
          s2: { baseUrl: s2.baseUrl, model: s2.model },
        },
      });
    });
    return () => sub.unsubscribe();
  }, [form, patch]);

  const testEndpoint = async (which: 's1' | 's2') => {
    const v = form.getValues(which);
    if (!/^https?:\/\/\S+$/.test(v.baseUrl.trim())) {
      form.setError(`${which}.baseUrl`, {
        message: 'Enter the endpoint URL, for example http://localhost:8000',
      });
      return;
    }
    form.clearErrors(`${which}.baseUrl`);
    if (which === 's1') {
      await runS1Probe({
        baseUrl: v.baseUrl.trim(),
        model: v.model.trim(),
        adapter: form.getValues('s1.adapter'),
        apiKey: v.apiKey,
      });
    } else {
      await runS2Probe({
        baseUrl: v.baseUrl.trim(),
        model: v.model.trim(),
        adapter: 'openai-chat',
        apiKey: v.apiKey,
      });
    }
  };

  const onSubmit = form.handleSubmit(async (v) => {
    setServerError(null);
    setSaving(true);
    try {
      if (v.s1.baseUrl !== '') {
        const detected = s1Probe.result?.ok === true ? s1Probe.result.adapter : undefined;
        const adapter = v.s1.adapter === 'auto' ? detected : v.s1.adapter;
        if (adapter === undefined) {
          form.setError('s1.adapter', {
            message: 'Run Test connection first so the adapter can be detected, or pick one',
          });
          return;
        }
        const s1Ref = apiKeyRefFrom(v.s1.apiKey);
        const s2Ref = apiKeyRefFrom(v.s2.apiKey);
        await utils.client.models.updateSettings.mutate({
          target: projectKey,
          settings: {
            system1: {
              adapter,
              baseUrl: v.s1.baseUrl,
              model: v.s1.model,
              ...(s1Ref ? { apiKeyRef: s1Ref } : {}),
            },
            ...(v.s2.baseUrl !== ''
              ? {
                  system2: {
                    adapter: 'openai-chat' as const,
                    baseUrl: v.s2.baseUrl,
                    model: v.s2.model,
                    ...(s2Ref ? { apiKeyRef: s2Ref } : {}),
                  },
                }
              : {}),
            thresholds: { act: v.act, pass: v.act, fail: 0.2, escalate: v.escalate },
            dualOrderSensitive: v.dualOrderSensitive,
          },
        });
      }
      await utils.client.projects.update.mutate({
        key: projectKey,
        dataPolicy: {
          sendPageText: v.sendPageText,
          sendScreenshots: v.sendScreenshots ? 'ambiguous' : 'never',
        },
      });
      await utils.models.status.invalidate();
      go('login');
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  });

  const cloudSystems = [
    s1Probe.result?.isCloud === true ? 'System 1' : null,
    s2Probe.result?.isCloud === true ? 'System 2' : null,
  ].filter((x): x is string => x !== null);

  const aBounds = actBounds(escalate);
  const eBounds = escalateBounds(act);

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-5">
        <Card
          aria-label="System 1 decision model"
          className="flex min-w-0 flex-[3_1_520px] flex-col gap-[18px] p-[22px]"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-fg">System 1 · decision model</h2>
            <p className="text-sm text-secondary">
              Picks every action and judges expected results. Local or cloud endpoint.
            </p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
            <Field label="API adapter" hint={fieldError(errors.s1?.adapter?.message)}>
              {(id) => (
                <Select id={id} {...form.register('s1.adapter', { onChange: resetS1Probe })}>
                  {S1_ADAPTERS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Base URL" hint={fieldError(errors.s1?.baseUrl?.message)}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="url"
                  placeholder="http://localhost:8000"
                  aria-invalid={errors.s1?.baseUrl !== undefined}
                  {...form.register('s1.baseUrl', { onChange: resetS1Probe })}
                />
              )}
            </Field>
            <Field label="Model" hint={fieldError(errors.s1?.model?.message)}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  autoComplete="off"
                  placeholder="Cloudflare/clef-flash"
                  aria-invalid={errors.s1?.model !== undefined}
                  {...form.register('s1.model')}
                />
              )}
            </Field>
            <Field
              label="API key (optional)"
              hint="Enter env:NAME to save a reference. A pasted key is used for Test connection only and is never stored."
            >
              {(id) => (
                <Input id={id} type="password" autoComplete="off" {...form.register('s1.apiKey')} />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              variant="primary"
              disabled={s1Probe.state === 'pending'}
              onClick={() => void testEndpoint('s1')}
            >
              Test connection
            </Button>
            <ProbeLine probe={s1Probe} label="System 1" />
          </div>
          <CapabilityGrid
            adapter={s1Probe.result?.ok === true ? s1Probe.result.adapter : undefined}
            capabilities={s1Probe.result?.capabilities}
          />
          {s1Probe.result?.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          <fieldset className="m-0 flex flex-col gap-3.5 rounded-control border border-divider p-4">
            <legend className="px-1.5 text-sm font-semibold text-fg">Confidence policy</legend>
            <div className="flex flex-wrap items-center gap-x-3">
              <label htmlFor="act-threshold" className="w-[220px] text-sm text-fg">
                Act / pass automatically at ≥
              </label>
              <div className="min-w-[200px] flex-1">
                <Range
                  id="act-threshold"
                  min={aBounds.min}
                  max={aBounds.max}
                  step={0.01}
                  value={act}
                  onChange={(e) => {
                    const next = constrainThresholds(
                      { act, escalate },
                      { act: Number(e.target.value) },
                    );
                    form.setValue('act', next.act);
                    form.setValue('escalate', next.escalate);
                  }}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3">
              <label htmlFor="escalate-threshold" className="w-[220px] text-sm text-fg">
                Escalate to human below
              </label>
              <div className="min-w-[200px] flex-1">
                <Range
                  id="escalate-threshold"
                  min={eBounds.min}
                  max={eBounds.max}
                  step={0.01}
                  value={escalate}
                  onChange={(e) => {
                    const next = constrainThresholds(
                      { act, escalate },
                      { escalate: Number(e.target.value) },
                    );
                    form.setValue('act', next.act);
                    form.setValue('escalate', next.escalate);
                  }}
                />
              </div>
            </div>
            <Checkbox
              label="Ask twice in shuffled order for sensitive actions"
              checked={dual}
              onChange={(e) => form.setValue('dualOrderSensitive', e.target.checked)}
            />
          </fieldset>
        </Card>

        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-5">
          <Card aria-label="System 2 fallback model" className="flex flex-col gap-3.5 p-[22px]">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-fg">System 2 · fallback</h2>
              <Pill tone="queued" className="font-normal">
                Optional
              </Pill>
            </div>
            <p className="text-sm text-secondary">
              Any OpenAI-compatible chat model. Used for second opinions, writing step text and
              generating test drafts.
            </p>
            <Field label="Base URL" hint={fieldError(errors.s2?.baseUrl?.message)}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  type="url"
                  placeholder="http://localhost:11434/v1"
                  aria-invalid={errors.s2?.baseUrl !== undefined}
                  {...form.register('s2.baseUrl', { onChange: resetS2Probe })}
                />
              )}
            </Field>
            <Field label="Model" hint={fieldError(errors.s2?.model?.message)}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  autoComplete="off"
                  placeholder="llama3.1:8b"
                  aria-invalid={errors.s2?.model !== undefined}
                  {...form.register('s2.model')}
                />
              )}
            </Field>
            <Field
              label="API key (optional)"
              hint="Enter env:NAME to save a reference. A pasted key is used for Test connection only and is never stored. Without a reference, S1PILOT_S2_API_KEY is used, or the System 1 key when both use the same host."
            >
              {(id) => (
                <Input id={id} type="password" autoComplete="off" {...form.register('s2.apiKey')} />
              )}
            </Field>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                variant="secondary"
                disabled={s2Probe.state === 'pending'}
                onClick={() => void testEndpoint('s2')}
              >
                Test connection
              </Button>
              <ProbeLine probe={s2Probe} label="System 2" />
            </div>
          </Card>

          <Card aria-label="Data policy" className="flex flex-col gap-3 p-[22px]">
            <h2 className="text-lg font-semibold text-fg">Data sent to models</h2>
            <Checkbox
              label="Page text and element list"
              checked={sendPageText}
              onChange={(e) => form.setValue('sendPageText', e.target.checked)}
            />
            <Checkbox
              label="Screenshots (only when ambiguous)"
              checked={sendScreenshots}
              onChange={(e) => form.setValue('sendScreenshots', e.target.checked)}
            />
            <Checkbox label="Redact emails, card numbers, tokens" checked disabled />
            <p className="-mt-1.5 text-xs text-muted">Redaction is always on.</p>
            {cloudSystems.length > 0 && (
              <Callout tone="warning">
                Cloud endpoint detected for {cloudSystems.join(' and ')} — page data leaves this
                machine.
              </Callout>
            )}
          </Card>
        </div>
      </div>
      {serverError !== null && <Callout tone="danger">{serverError}</Callout>}
      <WizardFooter
        onBack={() => go('environments')}
        continueLabel="Continue to login setup"
        pending={saving}
      />
    </form>
  );
}
