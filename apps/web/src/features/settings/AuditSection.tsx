import type { AuditEntry } from '@s1pilot/domain';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Callout, Card, CardHeader, EmptyState, Field, Input, Select, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/session';
import { trpc } from '@/lib/trpc';

/** Action filters: exact action or a prefix (`case.*`). */
export const AUDIT_ACTION_FILTERS = [
  { value: '', label: 'All actions' },
  { value: 'case.*', label: 'Case edits' },
  { value: 'plan.*', label: 'Plan edits' },
  { value: 'review.*', label: 'Review approvals' },
  { value: 'heal.*', label: 'Heal decisions' },
  { value: 'verdict.*', label: 'Verdict overrides' },
  { value: 'secret.*', label: 'Secret reveals' },
  { value: 'settings.*', label: 'Settings changes' },
  { value: 'run.*', label: 'Sign-offs and run control' },
  { value: 'user.*', label: 'Users and roles' },
  { value: 'auth.*', label: 'Sign-ins' },
] as const;

interface Filters {
  q: string;
  action: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { q: '', action: '', from: '', to: '' };

/** API input from the form: dates become whole UTC days. */
export function toAuditQuery(f: Filters) {
  return {
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...(f.action ? { action: f.action } : {}),
    ...(f.from ? { from: `${f.from}T00:00:00.000Z` } : {}),
    ...(f.to ? { to: `${f.to}T23:59:59.999Z` } : {}),
  };
}

function Changes({ entry }: { entry: AuditEntry }) {
  if (entry.before === null && entry.after === null) return <span className="text-secondary">-</span>;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-primary-text">Show changes</summary>
      <pre className="m-0 mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-surface-subtle p-2 font-mono text-[11px] text-fg">
        {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
      </pre>
    </details>
  );
}

/** Settings › Audit log: filterable table of edits, approvals, overrides and settings changes, with CSV export. */
export function AuditSection() {
  const allowed = useCan('audit:read');
  const utils = trpc.useUtils();
  const [form, setForm] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const query = useMemo(() => toAuditQuery(applied), [applied]);
  const first = trpc.audit.list.useQuery(query, { enabled: allowed });
  const [more, setMore] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMore([]);
    setCursor(undefined);
  }, [query]);

  if (!allowed) {
    return (
      <Card aria-label="Audit log" className="p-5">
        <EmptyState>Your role cannot read the audit log. Ask an admin or QA lead.</EmptyState>
      </Card>
    );
  }

  const entries = [...(first.data?.entries ?? []), ...more];
  const next = cursor === undefined ? (first.data?.nextBefore ?? null) : cursor;

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied(form);
  };
  const loadMore = async () => {
    if (next === null) return;
    setBusy(true);
    setError(null);
    try {
      const page = await utils.client.audit.list.query({ ...query, before: next });
      setMore((cur) => [...cur, ...page.entries]);
      setCursor(page.nextBefore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const exportCsv = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await utils.client.audit.exportCsv.query(query);
      const url = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = out.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card aria-label="Audit log">
      <CardHeader
        title="Audit log"
        action={
          <Button disabled={busy || entries.length === 0} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        }
      />
      <div className="flex flex-col gap-4 p-[18px]">
        <form onSubmit={apply} aria-label="Audit filters" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-end gap-3">
          <Field label="Search" hint="Actor, action or entity">
            {(id) => <Input id={id} value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} />}
          </Field>
          <Field label="Action">
            {(id) => (
              <Select id={id} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                {AUDIT_ACTION_FILTERS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="From">{(id) => <Input id={id} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
          <Button type="submit" variant="primary">
            Apply filters
          </Button>
        </form>
        {error !== null && <Callout tone="danger">{error}</Callout>}
        {first.error && <Callout tone="danger">{errorMessage(first.error)}</Callout>}
        {first.isLoading && (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        )}
        {first.data && entries.length === 0 && <EmptyState>No audit entries match these filters.</EmptyState>}
        {entries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-divider text-xs text-secondary">
                  <th className="py-2 pr-3 font-medium">When (UTC)</th>
                  <th className="py-2 pr-3 font-medium">Actor</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Entity</th>
                  <th className="py-2 pr-3 font-medium">Changes</th>
                  <th className="py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-divider-row align-top">
                    <td className="py-2 pr-3 font-mono text-xs">{e.at.slice(0, 19).replace('T', ' ')}</td>
                    <td className="py-2 pr-3">{e.actorName}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{e.action}</td>
                    <td className="py-2 pr-3">
                      <span className="text-secondary">{e.entityType}</span> <span className="font-mono text-xs">{e.entityId}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <Changes entry={e} />
                    </td>
                    <td className="py-2 font-mono text-xs">{e.ip ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next !== null && (
          <Button disabled={busy} onClick={() => void loadMore()}>
            Load older entries
          </Button>
        )}
      </div>
    </Card>
  );
}
