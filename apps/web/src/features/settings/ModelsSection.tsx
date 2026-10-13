import { useEffect, useState } from 'react';

import { CapabilityGrid } from '@/components/app/CapabilityGrid';
import { Button, Callout, Card, Checkbox, Field, Input, Pill, Range, Select, Skeleton } from '@/components/ui';
import { actBounds, apiKeyRefFrom, constrainThresholds, escalateBounds, keyFieldFrom, keyToSave, S1_ADAPTERS, type S1AdapterChoice } from '@/features/wizard/model';
import { KeyHint } from '@/features/wizard/shared';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Probe = RouterOutputs['models']['probe'];

interface Form {
  adapter: S1AdapterChoice;
  s1Url: string;
  s1Model: string;
  s1Key: string;
  /** `secret:model/…` ref of a key saved encrypted on the server (the key itself never reaches the browser). */
  s1Saved?: string;
  s1Remove: boolean;
  s2Url: string;
  s2Model: string;
  s2Key: string;
  s2Saved?: string;
  s2Remove: boolean;
  act: number;
  escalate: number;
  dual: boolean;
}

/** Where System 2 gets its key at run time when none is saved. */
const KEY_FALLBACK_S2 = 'Without a key, S1PILOT_S2_API_KEY is used, or the System 1 key when both use the same host.';

const EMPTY: Form = {
  adapter: 'systemone',
  s1Url: '',
  s1Model: '',
  s1Key: '',
  s1Remove: false,
  s2Url: '',
  s2Model: '',
  s2Key: '',
  s2Remove: false,
  act: 0.8,
  escalate: 0.5,
  dual: true,
};

type Saved = NonNullable<RouterOutputs['models']['getSettings']['settings']>;

function fromSaved(s: Saved | null): Form {
  if (!s) return EMPTY;
  const k1 = keyFieldFrom(s.system1.apiKeyRef);
  const k2 = keyFieldFrom(s.system2?.apiKeyRef);
  return {
    adapter: (S1_ADAPTERS.some((a) => a.value === s.system1.adapter) ? s.system1.adapter : 'auto') as S1AdapterChoice,
    s1Url: s.system1.baseUrl ?? '',
    s1Model: s.system1.model,
    s1Key: k1.text,
    ...(k1.savedRef !== undefined ? { s1Saved: k1.savedRef } : {}),
    s1Remove: false,
    s2Url: s.system2?.baseUrl ?? '',
    s2Model: s.system2?.model ?? '',
    s2Key: k2.text,
    ...(k2.savedRef !== undefined ? { s2Saved: k2.savedRef } : {}),
    s2Remove: false,
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
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
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
    const savedRef = which === 's1' ? (form.s1Remove ? undefined : form.s1Saved) : form.s2Remove ? undefined : form.s2Saved;
    // An empty field tests with the saved key; the server uses it only for the host it was saved for.
    const ref = apiKeyRefFrom(key) ?? (key === '' ? savedRef : undefined);
    setProbe({ state: 'pending', which });
    try {
      // Vanilla client: a pasted key must never enter the query cache.
      const result = await utils.client.models.probe.mutate({
        target: 'workspace',
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
        const k1 = keyToSave(form.s1Key, form.s1Saved, form.s1Remove);
        const k2 = keyToSave(form.s2Key, form.s2Saved, form.s2Remove);
        const hasS2 = form.s2Url.trim() !== '';
        // Vanilla client: a pasted key must never enter the query cache. The server stores it encrypted.
        await utils.client.models.updateSettings.mutate({
          target: 'workspace',
          settings: {
            system1: {
              adapter,
              baseUrl: form.s1Url.trim(),
              model: form.s1Model.trim(),
              ...(k1.apiKeyRef !== undefined ? { apiKeyRef: k1.apiKeyRef } : {}),
              ...(current?.system1.profileId ? { profileId: current.system1.profileId } : {}),
            },
            ...(hasS2
              ? { system2: { adapter: 'openai-chat' as const, baseUrl: form.s2Url.trim(), model: form.s2Model.trim(), ...(k2.apiKeyRef !== undefined ? { apiKeyRef: k2.apiKeyRef } : {}) } }
              : {}),
            thresholds: { act: form.act, pass: form.act, fail: current?.thresholds.fail ?? 0.2, escalate: form.escalate },
            dualOrderSensitive: form.dual,
          },
          apiKeys: {
            ...(k1.apiKey !== undefined ? { s1: k1.apiKey } : {}),
            ...(hasS2 && k2.apiKey !== undefined ? { s2: k2.apiKey } : {}),
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
          <Field
            label="API key (optional)"
            hint={<KeyHint saved={form.s1Saved !== undefined} removed={form.s1Remove} onToggleRemove={() => setForm((f) => ({ ...f, s1Remove: !f.s1Remove }))} />}
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                placeholder={form.s1Saved !== undefined && !form.s1Remove ? '••••••••  saved' : undefined}
                value={form.s1Key}
                onChange={(e) => setForm((f) => ({ ...f, s1Key: e.target.value }))}
              />
            )}
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
          <Field
            label="API key (optional)"
            hint={<KeyHint saved={form.s2Saved !== undefined} removed={form.s2Remove} onToggleRemove={() => setForm((f) => ({ ...f, s2Remove: !f.s2Remove }))} extra={KEY_FALLBACK_S2} />}
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                placeholder={form.s2Saved !== undefined && !form.s2Remove ? '••••••••  saved' : undefined}
                value={form.s2Key}
                onChange={(e) => setForm((f) => ({ ...f, s2Key: e.target.value }))}
              />
            )}
          </Field>
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
