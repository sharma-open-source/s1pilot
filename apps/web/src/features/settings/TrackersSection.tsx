import { useState } from 'react';

import { TRACKERS, type TrackerProvider } from './model';

import { Button, Callout, Dialog, Field, Input, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useProjects } from '@/lib/nav-data';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Connection = RouterOutputs['trackers']['list'][number];

/**
 * Jira, GitHub Issues and Linear cards for the Integrations grid. Credentials are write-only: they are sent through the
 * vanilla client (never the react-query mutation cache) and the server never returns them.
 */
export function TrackerCards() {
  const list = trpc.trackers.list.useQuery();
  const [open, setOpen] = useState<TrackerProvider | null>(null);
  return (
    <>
      {TRACKERS.map((t) => {
        const conn = list.data?.find((c) => c.provider === t.provider);
        return (
          <article key={t.provider} aria-label={t.name} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <strong className="text-fg">{t.name}</strong>
              <span className={conn?.connected ? 'text-[13px] font-semibold text-success-strong' : 'text-[13px] text-secondary'}>
                {conn?.connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <span className="text-[13px] text-secondary">{t.description}</span>
            <Button className="mt-auto self-start" onClick={() => setOpen(t.provider)} aria-label={`${conn?.connected ? 'Configure' : 'Connect'} ${t.name}`}>
              {conn?.connected ? 'Configure' : 'Connect'}
            </Button>
          </article>
        );
      })}
      {open !== null && <TrackerDialog provider={open} conn={list.data?.find((c) => c.provider === open)} onClose={() => setOpen(null)} />}
    </>
  );
}

function TrackerDialog({ provider, conn, onClose }: { provider: TrackerProvider; conn: Connection | undefined; onClose: () => void }) {
  const meta = TRACKERS.find((t) => t.provider === provider) as (typeof TRACKERS)[number];
  const utils = trpc.useUtils();
  const [baseUrl, setBaseUrl] = useState(conn?.baseUrl ?? '');
  const [email, setEmail] = useState(conn?.email ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const input = () => ({
    provider,
    ...(provider === 'jira' ? { baseUrl: baseUrl.trim(), email: email.trim() } : {}),
    ...(token !== '' ? { token } : {}),
  });
  const run = async (fn: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await fn());
    } catch (error) {
      setResult({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const test = () =>
    run(async () => {
      const r = await utils.client.trackers.test.mutate(input());
      return { ok: r.ok, text: r.detail };
    });
  const save = () =>
    run(async () => {
      const r = await utils.client.trackers.connect.mutate(input());
      setToken('');
      await utils.trackers.list.invalidate();
      return { ok: true, text: `Connected. ${r.detail}` };
    });
  const disconnect = () =>
    run(async () => {
      await utils.client.trackers.disconnect.mutate(provider);
      setToken('');
      await utils.trackers.list.invalidate();
      return { ok: true, text: 'Disconnected.' };
    });
  const canSubmit = !busy && (token !== '' || conn?.connected === true) && (provider !== 'jira' || (baseUrl.trim() !== '' && email.trim() !== ''));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${conn?.connected ? 'Configure' : 'Connect'} ${meta.name}`}
      description={meta.help}
      wide
      footer={
        <>
          {conn?.connected && (
            <Button variant="danger-outline" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </Button>
          )}
          <Button disabled={!canSubmit} onClick={() => void test()}>
            Test connection
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void save()}>
            Save connection
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void save();
        }}
      >
        {provider === 'jira' && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            <Field label="Site URL">{(id) => <Input id={id} mono value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://acme.atlassian.net" autoComplete="off" />}</Field>
            <Field label="Account email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}</Field>
          </div>
        )}
        <Field label={meta.tokenLabel} hint={conn?.connected ? 'A token is saved. Leave empty to keep it.' : 'Stored encrypted and never shown again.'}>
          {(id) => <Input id={id} type="password" mono value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={conn?.connected ? 'Saved' : ''} />}
        </Field>
        {result && <Callout tone={result.ok ? 'success' : 'danger'}>{result.text}</Callout>}
      </form>
      {conn?.connected && (
        <>
          <MappingForm provider={provider} />
          {provider !== 'linear' && <WebhookBox provider={provider} enabled={conn.webhookEnabled} />}
        </>
      )}
    </Dialog>
  );
}

function MappingForm({ provider }: { provider: TrackerProvider }) {
  const projects = useProjects().data;
  const [picked, setPicked] = useState('');
  const projectKey = picked || projects[0]?.key || '';
  const current = trpc.trackers.mapping.useQuery({ projectKey }, { enabled: projectKey !== '' });
  const utils = trpc.useUtils();
  const mine = current.data?.provider === provider ? current.data : undefined;
  const [edits, setEdits] = useState<{ key: string; jiraProject?: string; jiraIssueType?: string; githubRepo?: string; linearTeamId?: string }>({ key: '' });
  const e = edits.key === projectKey ? edits : { key: projectKey };
  const jiraProject = e.jiraProject ?? mine?.jiraProject ?? '';
  const jiraIssueType = e.jiraIssueType ?? mine?.jiraIssueType ?? 'Bug';
  const githubRepo = e.githubRepo ?? mine?.githubRepo ?? '';
  const linearTeamId = e.linearTeamId ?? mine?.linearTeamId ?? '';
  const set = (patch: Partial<typeof edits>) => setEdits({ ...e, ...patch, key: projectKey });
  const save = trpc.trackers.setMapping.useMutation({ onSuccess: () => void utils.trackers.mapping.invalidate() });
  const submit = (clear: boolean) =>
    save.mutate({
      projectKey,
      mapping: clear
        ? null
        : {
            provider,
            ...(provider === 'jira' ? { jiraProject: jiraProject.trim(), jiraIssueType: jiraIssueType.trim() || 'Bug' } : {}),
            ...(provider === 'github' ? { githubRepo: githubRepo.trim() } : {}),
            ...(provider === 'linear' ? { linearTeamId: linearTeamId.trim() } : {}),
          },
    });
  const other = current.data && current.data.provider !== provider ? current.data : undefined;

  return (
    <section aria-label="Project mapping" className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="m-0 text-[15px] font-semibold">Project mapping</h3>
      {projects.length === 0 ? (
        <span className="text-[13px] text-secondary">Create a project first.</span>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
            <Field label="Project">
              {(id) => (
                <Select id={id} value={projectKey} onChange={(ev) => setPicked(ev.target.value)}>
                  {projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} · {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {provider === 'jira' && (
              <>
                <Field label="Jira project key">{(id) => <Input id={id} mono value={jiraProject} onChange={(ev) => set({ jiraProject: ev.target.value })} placeholder="SHOP" />}</Field>
                <Field label="Issue type">{(id) => <Input id={id} value={jiraIssueType} onChange={(ev) => set({ jiraIssueType: ev.target.value })} />}</Field>
              </>
            )}
            {provider === 'github' && <Field label="Repository">{(id) => <Input id={id} mono value={githubRepo} onChange={(ev) => set({ githubRepo: ev.target.value })} placeholder="owner/name" />}</Field>}
            {provider === 'linear' && <Field label="Team id">{(id) => <Input id={id} mono value={linearTeamId} onChange={(ev) => set({ linearTeamId: ev.target.value })} />}</Field>}
          </div>
          {other && <span className="text-[13px] text-secondary">This project currently pushes to {other.label}. Saving switches it to {provider}.</span>}
          {mine && <span className="text-[13px] text-secondary">Synced with {mine.label}.</span>}
          {save.isError && <Callout tone="danger">{errorMessage(save.error)}</Callout>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={save.isPending || projectKey === ''} onClick={() => submit(false)}>
              Save mapping
            </Button>
            {mine && (
              <Button disabled={save.isPending} onClick={() => submit(true)}>
                Remove mapping
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Inbound webhook URL; the secret part is shown once, right after it is generated. */
function WebhookBox({ provider, enabled }: { provider: 'jira' | 'github'; enabled: boolean }) {
  const utils = trpc.useUtils();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    setError(null);
    try {
      const r = await utils.client.trackers.rotateWebhook.mutate(provider);
      setUrl(`${window.location.origin}${r.path}`);
      await utils.trackers.list.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <section aria-label="Webhook" className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="m-0 text-[15px] font-semibold">Webhook</h3>
      <span className="text-[13px] text-secondary">Status is also polled every 10 minutes. Add this URL as a webhook for issue events to update defects at once.</span>
      {url ? (
        <>
          <code className="break-all rounded-control bg-canvas px-3 py-2 font-mono text-[13px]">{url}</code>
          <span className="text-[13px] text-secondary">Copy it now; it is not shown again.</span>
        </>
      ) : (
        <span className="text-[13px] text-secondary">{enabled ? 'A webhook URL is active.' : 'No webhook URL yet.'}</span>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <Button className="self-start" onClick={() => void generate()}>
        {enabled || url ? 'Generate new webhook URL' : 'Generate webhook URL'}
      </Button>
    </section>
  );
}
