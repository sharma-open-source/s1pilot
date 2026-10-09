import { useEffect, useState } from 'react';

import { CapabilityGrid } from '@/components/app/CapabilityGrid';
import { Button, Callout, Card, Checkbox, Field, Input, Pill, Range, Select, Skeleton } from '@/components/ui';
import { actBounds, apiKeyRefFrom, constrainThresholds, escalateBounds, S1_ADAPTERS, type S1AdapterChoice } from '@/features/wizard/model';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Probe = RouterOutputs['models']['probe'];

interface Form {
  adapter: S1AdapterChoice;
  s1Url: string;
  s1Model: string;
  s1Key: string;
  s2Url: string;
  s2Model: string;
  s2Key: string;
  act: number;
  escalate: number;
  dual: boolean;
}

const EMPTY: Form = { adapter: 'systemone', s1Url: '', s1Model: '', s1Key: '', s2Url: '', s2Model: '', s2Key: '', act: 0.8, escalate: 0.5, dual: true };

type Saved = NonNullable<RouterOutputs['models']['getSettings']['settings']>;

function fromSaved(s: Saved | null): Form {
  if (!s) return EMPTY;
  return {
    adapter: (S1_ADAPTERS.some((a) => a.value === s.system1.adapter) ? s.system1.adapter : 'auto') as S1AdapterChoice,
    s1Url: s.system1.baseUrl ?? '',
    s1Model: s.system1.model,
    s1Key: s.system1.apiKeyRef ?? '',
    s2Url: s.system2?.baseUrl ?? '',
    s2Model: s.system2?.model ?? '',
    s2Key: s.system2?.apiKeyRef ?? '',
    act: s.thresholds.act,
    escalate: s.thresholds.escalate,
    dual: s.dualOrderSensitive,
  };
}

/** Workspace default model settings. Projects inherit these unless they override them (wizard step 3). */
export function ModelsSection() {
  const utils = trpc.useUtils();
  const q = trpc.models.getSettings.useQuery('workspace');
  const [form, setForm] = useState<Form>(EMPTY);
  const [probe, setProbe] = useState<{ state: 'idle' | 'pending' | 'done'; result?: Probe; error?: string; which?: 's1' | 's2' }>({ state: 'idle' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data) setForm(fromSaved(q.data.settings as Saved | null));
  }, [q.data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setProbe({ state: 'idle' });
  };

  if (q.isLoading) {
    return (
      <Card className="flex flex-col gap-3 p-5" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </Card>
    );
  }
  if (q.error) return <Callout tone="danger">{errorMessage(q.error)}</Callout>;

  const test = async (which: 's1' | 's2') => {
    const baseUrl = (which === 's1' ? form.s1Url : form.s2Url).trim();
    if (!/^https?:\/\/\S+$/.test(baseUrl)) {
      setProbe({ state: 'done', which, error: 'Enter the endpoint URL, for example http://localhost:8000' });
      return;
    }
    const model = (which === 's1' ? form.s1Model : form.s2Model).trim();
    const key = (which === 's1' ? form.s1Key : form.s2Key).trim();
    const ref = apiKeyRefFrom(key);
    setProbe({ state: 'pending', which });
    try {
      // Vanilla client: a pasted key must never enter the query cache.
      const result = await utils.client.models.probe.mutate({
        baseUrl,
        adapter: which === 's1' ? form.adapter : 'openai-chat',
        ...(model !== '' ? { model } : {}),
        ...(key !== '' && ref === undefined ? { apiKey: key } : {}),
        ...(ref !== undefined ? { apiKeyRef: ref } : {}),
        timeoutMs: 30_000,
      });
      setProbe({ state: 'done', which, result, ...(result.ok ? {} : { error: result.error ?? 'Could not connect' }) });
    } catch (err) {
      setProbe({ state: 'done', which, error: errorMessage(err) });
    }
  };

  const save = async () => {
    setMsg(null);
    setSaving(true);
    try {
      const detected = probe.which === 's1' && probe.result?.ok ? probe.result.adapter : undefined;
      const adapter = form.adapter === 'auto' ? detected : form.adapter;
      const current = q.data?.settings as Saved | null | undefined;
      if (form.s1Url.trim() === '') {
        await utils.client.models.updateSettings.mutate({ target: 'workspace', settings: null });
      } else {
        if (adapter === undefined) throw new Error('Run Test connection first so the adapter can be detected, or pick one');
        if (form.s1Model.trim() === '') throw new Error('Enter the System 1 model id');
        const s1Ref = apiKeyRefFrom(form.s1Key);
        const s2Ref = apiKeyRefFrom(form.s2Key);
        await utils.client.models.updateSettings.mutate({
          target: 'workspace',
          settings: {
            system1: {
              adapter,
              baseUrl: form.s1Url.trim(),
              model: form.s1Model.trim(),
              ...(s1Ref ? { apiKeyRef: s1Ref } : {}),
              ...(current?.system1.profileId ? { profileId: current.system1.profileId } : {}),
            },
            ...(form.s2Url.trim() !== ''
              ? { system2: { adapter: 'openai-chat' as const, baseUrl: form.s2Url.trim(), model: form.s2Model.trim(), ...(s2Ref ? { apiKeyRef: s2Ref } : {}) } }
              : {}),
            thresholds: { act: form.act, pass: form.act, fail: current?.thresholds.fail ?? 0.2, escalate: form.escalate },
            dualOrderSensitive: form.dual,
          },
        });
      }
      await Promise.all([utils.models.getSettings.invalidate(), utils.models.status.invalidate()]);
      setMsg({ tone: 'success', text: 'Workspace model defaults saved' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const aBounds = actBounds(form.escalate);
  const eBounds = escalateBounds(form.act);
  const line = (which: 's1' | 's2') =>
    probe.which !== which || probe.state === 'idle' ? null : probe.state === 'pending' ? (
      <span role="status" className="text-sm text-secondary">Testing…</span>
    ) : probe.error ? (
      <span role="alert" className="text-sm text-danger">{probe.error}</span>
    ) : (
      <span role="status" className="text-sm text-success">Connected · decision returned in {probe.result?.latencyMs.p50 ?? 0} ms</span>
    );

  return (
    <Card aria-label="Models and endpoints" className="flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold text-fg">Models &amp; endpoints</h2>
        <p className="m-0 text-sm text-secondary">Workspace defaults. Projects use these unless they set their own models.</p>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="text-base font-semibold text-fg">System 1 · decision model</h3>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
          <Field label="API adapter">
            {(id) => (
              <Select id={id} value={form.adapter} onChange={(e) => set('adapter', e.target.value as S1AdapterChoice)}>
                {S1_ADAPTERS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Base URL">{(id) => <Input id={id} mono type="url" placeholder="http://localhost:8000" value={form.s1Url} onChange={(e) => set('s1Url', e.target.value)} />}</Field>
          <Field label="Model">{(id) => <Input id={id} mono autoComplete="off" value={form.s1Model} onChange={(e) => set('s1Model', e.target.value)} />}</Field>
          <Field label="API key (optional)" hint="Enter env:NAME to save a reference. A pasted key is used for Test connection only and is never stored.">
            {(id) => <Input id={id} type="password" autoComplete="off" value={form.s1Key} onChange={(e) => setForm((f) => ({ ...f, s1Key: e.target.value }))} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="primary" disabled={probe.state === 'pending'} onClick={() => void test('s1')}>Test connection</Button>
          {line('s1')}
        </div>
        {probe.which === 's1' && probe.result?.ok && <CapabilityGrid adapter={probe.result.adapter} capabilities={probe.result.capabilities} />}
        {probe.which === 's1' && probe.result?.warnings.map((w) => <Callout key={w} tone="warning">{w}</Callout>)}
      </div>

      <fieldset className="m-0 flex flex-col gap-3.5 rounded-control border border-divider p-4">
        <legend className="px-1.5 text-sm font-semibold text-fg">Confidence policy</legend>
        <div className="flex flex-wrap items-center gap-x-3">
          <label htmlFor="ws-act" className="w-[220px] text-sm text-fg">Act / pass automatically at ≥</label>
          <div className="min-w-[200px] flex-1">
            <Range id="ws-act" min={aBounds.min} max={aBounds.max} step={0.01} value={form.act}
              onChange={(e) => setForm((f) => ({ ...f, ...constrainThresholds(f, { act: Number(e.target.value) }) }))} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3">
          <label htmlFor="ws-escalate" className="w-[220px] text-sm text-fg">Escalate to human below</label>
          <div className="min-w-[200px] flex-1">
            <Range id="ws-escalate" min={eBounds.min} max={eBounds.max} step={0.01} value={form.escalate}
              onChange={(e) => setForm((f) => ({ ...f, ...constrainThresholds(f, { escalate: Number(e.target.value) }) }))} />
          </div>
        </div>
        <Checkbox label="Ask twice in shuffled order for sensitive actions" checked={form.dual} onChange={(e) => setForm((f) => ({ ...f, dual: e.target.checked }))} />
      </fieldset>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <h3 className="text-base font-semibold text-fg">System 2 · fallback</h3>
          <Pill tone="queued" className="font-normal">Optional</Pill>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
          <Field label="Base URL">{(id) => <Input id={id} mono type="url" placeholder="http://localhost:11434/v1" value={form.s2Url} onChange={(e) => set('s2Url', e.target.value)} />}</Field>
          <Field label="Model">{(id) => <Input id={id} mono autoComplete="off" value={form.s2Model} onChange={(e) => set('s2Model', e.target.value)} />}</Field>
          <Field label="API key (optional)">{(id) => <Input id={id} type="password" autoComplete="off" value={form.s2Key} onChange={(e) => setForm((f) => ({ ...f, s2Key: e.target.value }))} />}</Field>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button disabled={probe.state === 'pending'} onClick={() => void test('s2')}>Test connection</Button>
          {line('s2')}
        </div>
      </div>

      {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
      <div>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>Save model defaults</Button>
      </div>
    </Card>
  );
}
