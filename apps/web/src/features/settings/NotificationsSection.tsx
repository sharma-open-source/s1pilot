import { useState } from 'react';

import { Button, Callout, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, Select, Skeleton, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

type Kind = 'slack' | 'teams' | 'email' | 'webhook';
const KIND_LABEL: Record<Kind, string> = { slack: 'Slack', teams: 'Microsoft Teams', email: 'Email (SMTP)', webhook: 'Outbound webhook' };
const EVENTS = [
  { id: 'run.finished', label: 'Run finished' },
  { id: 'approval.required', label: 'Approval needed (waiting over 1 min)' },
  { id: 'review.threshold', label: 'Review queue above threshold' },
  { id: 'defect.created', label: 'Defect created' },
] as const;
type EventId = (typeof EVENTS)[number]['id'];
const eventLabel = (id: string): string => EVENTS.find((e) => e.id === id)?.label ?? id;

interface ChannelRow {
  id: string;
  name: string;
  kind: Kind;
  config: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
}

const SECRET_HINT = 'Paste the value, or use env:NAME to read it from a server environment variable.';

/** Form state of the channel dialog; `secrets` are write-only. */
interface ChannelForm {
  id?: string;
  name: string;
  kind: Kind;
  channel: string;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  from: string;
  to: string;
  secrets: { webhookUrl: string; botToken: string; pass: string; url: string; secret: string };
}

const emptyForm = (): ChannelForm => ({
  name: '',
  kind: 'slack',
  channel: '',
  host: '',
  port: '587',
  secure: false,
  user: '',
  from: '',
  to: '',
  secrets: { webhookUrl: '', botToken: '', pass: '', url: '', secret: '' },
});

function formFrom(c: ChannelRow): ChannelForm {
  const f = emptyForm();
  const cfg = c.config;
  return {
    ...f,
    id: c.id,
    name: c.name,
    kind: c.kind,
    channel: typeof cfg.channel === 'string' ? cfg.channel : '',
    host: typeof cfg.host === 'string' ? cfg.host : '',
    port: typeof cfg.port === 'number' ? String(cfg.port) : '587',
    secure: cfg.secure === true,
    user: typeof cfg.user === 'string' ? cfg.user : '',
    from: typeof cfg.from === 'string' ? cfg.from : '',
    to: Array.isArray(cfg.to) ? (cfg.to as string[]).join(', ') : '',
  };
}

const opt = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

/** Builds the API config for the selected kind (empty secrets are left out so stored ones are kept). */
function toConfig(f: ChannelForm) {
  const s = f.secrets;
  switch (f.kind) {
    case 'slack':
      return { kind: 'slack' as const, webhookUrl: opt(s.webhookUrl), botToken: opt(s.botToken), channel: opt(f.channel) };
    case 'teams':
      return { kind: 'teams' as const, webhookUrl: opt(s.webhookUrl) ?? '' };
    case 'email':
      return {
        kind: 'email' as const,
        host: f.host.trim(),
        port: Number(f.port) || 587,
        secure: f.secure,
        user: opt(f.user),
        pass: opt(s.pass),
        from: f.from.trim(),
        to: f.to.split(/[,\s]+/).filter(Boolean),
      };
    case 'webhook':
      return { kind: 'webhook' as const, url: opt(s.url) ?? '', secret: opt(s.secret) };
  }
}

function SecretInput({ label, value, isSet, onChange }: { label: string; value: string; isSet: boolean; onChange: (v: string) => void }) {
  return (
    <Field label={label} hint={isSet ? `A value is stored. Leave empty to keep it. ${SECRET_HINT}` : SECRET_HINT}>
      {(id) => <Input id={id} type="password" autoComplete="off" mono value={value} placeholder={isSet ? '••••••••' : ''} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function ChannelDialog({ open, initial, secretsSet, onClose }: { open: boolean; initial: ChannelForm; secretsSet: Record<string, boolean>; onClose: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.notifications.channels.save.useMutation();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const setSecret = (k: keyof ChannelForm['secrets'], v: string) => setForm((f) => ({ ...f, secrets: { ...f.secrets, [k]: v } }));

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({ ...(form.id ? { id: form.id } : {}), name: form.name, config: toConfig(form) });
      await utils.notifications.channels.list.invalidate();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={form.id ? 'Edit channel' : 'Add channel'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={save.isPending || form.name.trim() === ''} onClick={() => void submit()}>
            Save channel
          </Button>
        </>
      }
    >
      <Field label="Name" hint="For example Slack #qa">
        {(id) => <Input id={id} value={form.name} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field label="Type">
        {(id) => (
          <Select id={id} value={form.kind} disabled={form.id !== undefined} onChange={(e) => set({ kind: e.target.value as Kind })}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {form.kind === 'slack' && (
        <>
          <SecretInput label="Incoming webhook URL" value={form.secrets.webhookUrl} isSet={secretsSet.webhookUrl === true} onChange={(v) => setSecret('webhookUrl', v)} />
          <SecretInput label="Bot token (alternative)" value={form.secrets.botToken} isSet={secretsSet.botToken === true} onChange={(v) => setSecret('botToken', v)} />
          <Field label="Channel (bot token only)">{(id) => <Input id={id} value={form.channel} placeholder="#qa" onChange={(e) => set({ channel: e.target.value })} />}</Field>
        </>
      )}
      {form.kind === 'teams' && <SecretInput label="Incoming webhook URL" value={form.secrets.webhookUrl} isSet={secretsSet.webhookUrl === true} onChange={(v) => setSecret('webhookUrl', v)} />}
      {form.kind === 'webhook' && (
        <>
          <SecretInput label="Endpoint URL" value={form.secrets.url} isSet={secretsSet.url === true} onChange={(v) => setSecret('url', v)} />
          <SecretInput label="Signing secret" value={form.secrets.secret} isSet={secretsSet.secret === true} onChange={(v) => setSecret('secret', v)} />
          <p className="m-0 text-xs text-muted">
            Requests carry <code className="font-mono">x-s1pilot-timestamp</code> and <code className="font-mono">x-s1pilot-signature</code> (sha256 HMAC of timestamp.body).
          </p>
        </>
      )}
      {form.kind === 'email' && (
        <>
          <Field label="SMTP host">{(id) => <Input id={id} mono value={form.host} onChange={(e) => set({ host: e.target.value })} />}</Field>
          <Field label="Port">{(id) => <Input id={id} mono inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value })} />}</Field>
          <Checkbox label="Use TLS from the start (port 465)" checked={form.secure} onChange={(e) => set({ secure: e.target.checked })} />
          <Field label="User">{(id) => <Input id={id} autoComplete="off" value={form.user} onChange={(e) => set({ user: e.target.value })} />}</Field>
          <SecretInput label="Password" value={form.secrets.pass} isSet={secretsSet.pass === true} onChange={(v) => setSecret('pass', v)} />
          <Field label="From">{(id) => <Input id={id} value={form.from} placeholder="s1pilot@example.com" onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label="Recipients" hint="Comma separated">
            {(id) => <Input id={id} value={form.to} onChange={(e) => set({ to: e.target.value })} />}
          </Field>
        </>
      )}
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function RuleDialog({ open, channels, onClose }: { open: boolean; channels: ChannelRow[]; onClose: () => void }) {
  const utils = trpc.useUtils();
  const projects = trpc.projects.list.useQuery();
  const save = trpc.notifications.rules.save.useMutation();
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const [projectKey, setProjectKey] = useState('');
  const [events, setEvents] = useState<EventId[]>(['run.finished']);
  const [onlyOnFailure, setOnlyOnFailure] = useState(false);
  const [threshold, setThreshold] = useState('10');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({
        channelId,
        projectKey: projectKey === '' ? null : projectKey,
        planId: null,
        events,
        onlyOnFailure,
        reviewThreshold: Number(threshold) || 10,
      });
      await utils.notifications.rules.list.invalidate();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add rule"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={save.isPending || channelId === '' || events.length === 0} onClick={() => void submit()}>
            Save rule
          </Button>
        </>
      }
    >
      <Field label="Channel">
        {(id) => (
          <Select id={id} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Project">
        {(id) => (
          <Select id={id} value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-[13px] font-medium text-fg">Events</legend>
        {EVENTS.map((e) => (
          <Checkbox key={e.id} label={e.label} checked={events.includes(e.id)} onChange={(ev) => setEvents((cur) => (ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id)))} />
        ))}
      </fieldset>
      {events.includes('review.threshold') && (
        <Field label="Review queue threshold" hint="Notify when more than this many items are pending.">
          {(id) => <Input id={id} mono inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />}
        </Field>
      )}
      <Checkbox label="Only when a run fails (applies to run finished)" checked={onlyOnFailure} onChange={(e) => setOnlyOnFailure(e.target.checked)} />
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function ChannelsCard({ channels }: { channels: ChannelRow[] }) {
  const utils = trpc.useUtils();
  const test = trpc.notifications.channels.test.useMutation();
  const del = trpc.notifications.channels.delete.useMutation();
  const [editing, setEditing] = useState<{ form: ChannelForm; secretsSet: Record<string, boolean>; key: number } | null>(null);
  const [deleting, setDeleting] = useState<ChannelRow | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const runTest = async (c: ChannelRow) => {
    setResults((r) => ({ ...r, [c.id]: 'Sending…' }));
    try {
      const out = await test.mutateAsync({ id: c.id });
      setResults((r) => ({ ...r, [c.id]: out.ok ? 'Test message delivered.' : `Failed after ${out.attempts} attempts: ${out.error ?? 'unknown error'}` }));
      await utils.notifications.log.invalidate();
    } catch (err) {
      setResults((r) => ({ ...r, [c.id]: errorMessage(err) }));
    }
  };

  const remove = async (c: ChannelRow) => {
    setDeleting(null);
    setError(null);
    try {
      await del.mutateAsync({ id: c.id });
      await Promise.all([utils.notifications.channels.list.invalidate(), utils.notifications.rules.list.invalidate()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card aria-label="Channels">
      <CardHeader title="Channels" action={<Button variant="primary" onClick={() => setEditing({ form: emptyForm(), secretsSet: {}, key: Date.now() })}>Add channel</Button>} />
      <div className="flex flex-col gap-3 p-[18px]">
        {error !== null && <Callout tone="danger">{error}</Callout>}
        {channels.length === 0 && <EmptyState>No channels yet. Add Slack, Teams, email or a webhook to get notified.</EmptyState>}
        {channels.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0">
            {channels.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-divider-row py-3 last:border-b-0">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium text-fg">
                    {c.name} <Tag>{KIND_LABEL[c.kind]}</Tag>
                  </span>
                  {results[c.id] !== undefined && (
                    <span role="status" className="text-xs text-secondary">
                      {results[c.id]}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button aria-label={`Send test to ${c.name}`} onClick={() => void runTest(c)}>
                    Test send
                  </Button>
                  <Button aria-label={`Edit ${c.name}`} onClick={() => setEditing({ form: formFrom(c), secretsSet: c.secretsSet, key: Date.now() })}>
                    Edit
                  </Button>
                  <Button variant="danger-outline" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing !== null && <ChannelDialog key={editing.key} open initial={editing.form} secretsSet={editing.secretsSet} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'channel'}?`}
        description="Its rules are removed too."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => deleting !== null && void remove(deleting)}
      />
    </Card>
  );
}

function RulesCard({ channels }: { channels: ChannelRow[] }) {
  const utils = trpc.useUtils();
  const rules = trpc.notifications.rules.list.useQuery();
  const del = trpc.notifications.rules.delete.useMutation({ onSuccess: () => utils.notifications.rules.list.invalidate() });
  const [adding, setAdding] = useState(false);
  const channelName = (id: string): string => channels.find((c) => c.id === id)?.name ?? 'Unknown channel';

  return (
    <Card aria-label="Rules">
      <CardHeader title="Rules" action={<Button variant="primary" disabled={channels.length === 0} onClick={() => setAdding(true)}>Add rule</Button>} />
      <div className="flex flex-col gap-3 p-[18px]">
        {rules.isLoading && <Skeleton className="h-11 w-full" />}
        {rules.error && <Callout tone="danger">{errorMessage(rules.error)}</Callout>}
        {rules.data && rules.data.length === 0 && <EmptyState>{channels.length === 0 ? 'Add a channel first, then choose which events it receives.' : 'No rules yet. A channel only receives events that a rule subscribes it to.'}</EmptyState>}
        {rules.data && rules.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="text-xs text-secondary">
                  <th className="py-2 pr-3 font-medium">Channel</th>
                  <th className="py-2 pr-3 font-medium">Scope</th>
                  <th className="py-2 pr-3 font-medium">Events</th>
                  <th className="py-2 pr-3 font-medium">Only on failure</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr key={r.id} className="border-t border-divider-row align-top">
                    <td className="py-2.5 pr-3 text-fg">{channelName(r.channelId)}</td>
                    <td className="py-2.5 pr-3 text-fg">
                      {r.planId !== null ? 'One plan' : r.projectKey !== null ? <span className="font-mono">{r.projectKey}</span> : 'All projects'}
                    </td>
                    <td className="py-2.5 pr-3 text-fg">
                      {r.events.map(eventLabel).join(', ')}
                      {r.events.includes('review.threshold') && <span className="text-secondary"> (over {r.reviewThreshold})</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-fg">{r.onlyOnFailure ? 'Yes' : 'No'}</td>
                    <td className="py-2.5 text-right">
                      <Button variant="danger-outline" aria-label={`Delete rule for ${channelName(r.channelId)}`} onClick={() => del.mutate({ id: r.id })}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && <RuleDialog open channels={channels} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function DeliveryLogCard() {
  const log = trpc.notifications.log.useQuery();
  return (
    <Card aria-label="Delivery log">
      <CardHeader title="Delivery log" />
      <div className="flex flex-col gap-3 p-[18px]">
        {log.isLoading && <Skeleton className="h-11 w-full" />}
        {log.error && <Callout tone="danger">{errorMessage(log.error)}</Callout>}
        {log.data && log.data.length === 0 && <EmptyState>Nothing has been sent yet. The last 100 deliveries are kept here.</EmptyState>}
        {log.data && log.data.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0">
            {log.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-divider-row py-2 text-[13px] last:border-b-0">
                <span className="text-fg">
                  <strong>{d.ok ? 'Delivered' : 'Failed'}</strong> · {d.channelName} · <span className="font-mono">{d.event}</span>
                </span>
                <span className="text-xs text-secondary">
                  {d.ok ? (d.attempts > 1 ? `after ${d.attempts} attempts` : '') : `${d.attempts} attempts: ${d.error ?? ''}`} <span className="font-mono">{d.at.replace('T', ' ').slice(0, 19)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** Settings › Notifications: channels (with test send), subscription rules and the delivery log. */
export function NotificationsSection() {
  const channels = trpc.notifications.channels.list.useQuery();
  return (
    <>
      {channels.isLoading && (
        <Card aria-busy="true" className="p-5">
          <Skeleton className="h-11 w-full" />
        </Card>
      )}
      {channels.error && <Callout tone="danger">{errorMessage(channels.error)}</Callout>}
      {channels.data && (
        <>
          <ChannelsCard channels={channels.data as ChannelRow[]} />
          <RulesCard channels={channels.data as ChannelRow[]} />
          <DeliveryLogCard />
        </>
      )}
    </>
  );
}
