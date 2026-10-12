import type { Priority, TestCaseStatus, TestCaseType } from '@s1pilot/domain';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useState } from 'react';

import { RequirementDialog } from '../requirements/RequirementDialog';

import { learnedSummary, type LearnedInfo } from './LearnedTab';
import { paramNames, type Draft } from './model';

import { Button, Card, Input, Pill, Select, Tag } from '@/components/ui';
import { trpc } from '@/lib/trpc';

const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const TYPES: TestCaseType[] = ['smoke', 'regression', 'e2e', 'exploratory'];
const STATUSES: Array<{ value: TestCaseStatus; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'ready', label: 'Ready' },
  { value: 'deprecated', label: 'Deprecated' },
];

interface CaseAsideProps {
  projectKey: string;
  caseKey: string;
  draft: Draft;
  learned: LearnedInfo[];
  onChange: (change: Partial<Draft>) => void;
  /** Link target of "Edit in Parameters tab". */
  parametersHref: string;
}

function TagEditor({ label, values, onChange, mono }: { label: string; values: string[]; onChange: (v: string[]) => void; mono?: boolean }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t !== '' && !values.includes(t)) onChange([...values, t]);
    setText('');
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Tag key={v} mono={mono} className="gap-1 text-[13px]">
            {v}
            <button
              type="button"
              aria-label={`Remove ${label} ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="inline-flex h-[24px] w-[24px] items-center justify-center border-0 bg-transparent text-secondary"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </Tag>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input aria-label={`New ${label}`} placeholder={`Add ${label}`} className="h-[36px] flex-1 text-[13px]" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="secondary" size="sm">
          Add
        </Button>
      </form>
    </div>
  );
}

function Row({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = `aside-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

/** Right column of the editor: Details, Parameters mini-table and Learned script summary. */
export function CaseAside({ projectKey, draft, learned, onChange, parametersHref }: CaseAsideProps) {
  const reqs = trpc.requirements.list.useQuery({ projectKey });
  const names = paramNames(draft.parameters);
  const unlinked = (reqs.data ?? []).filter((r) => !draft.requirements.includes(r.key));
  const selectClass = 'h-[36px] w-auto min-w-[8rem] text-[14px]';
  const [newReqOpen, setNewReqOpen] = useState(false);

  return (
    <aside aria-label="Case details" className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
      <Card aria-label="Details" className="flex flex-col gap-3 p-[18px] text-sm">
        <h2 className="text-[15px] font-semibold">Details</h2>
        <Row label="Priority">
          {(id) => (
            <Select id={id} className={selectClass} value={draft.priority} onChange={(e) => onChange({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          )}
        </Row>
        <Row label="Type">
          {(id) => (
            <Select id={id} className={selectClass} value={draft.type} onChange={(e) => onChange({ type: e.target.value as TestCaseType })}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          )}
        </Row>
        <Row label="Status">
          {(id) => (
            <Select id={id} className={selectClass} value={draft.status} onChange={(e) => onChange({ status: e.target.value as TestCaseStatus })}>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Row>
        <TagEditor label="tag" values={draft.tags} onChange={(tags) => onChange({ tags })} />
        <div className="flex flex-col gap-2">
          <div>
            <Link to={'/p/$key/library/requirements' as never} params={{ key: projectKey } as never} className="text-fg">
              Requirements
            </Link>{' '}
            ·{' '}
            {draft.requirements.length === 0 ? (
              <span className="text-secondary">none</span>
            ) : (
              draft.requirements.map((r, i) => (
                <span key={r}>
                  {i > 0 && ', '}
                  <Link to={'/p/$key/library/requirements' as never} params={{ key: projectKey } as never} className="font-mono text-primary-text">
                    {r}
                  </Link>
                  <button
                    type="button"
                    aria-label={`Unlink requirement ${r}`}
                    onClick={() => onChange({ requirements: draft.requirements.filter((x) => x !== r) })}
                    className="ml-0.5 inline-flex h-[24px] w-[24px] items-center justify-center border-0 bg-transparent align-middle text-secondary"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex gap-2">
            {unlinked.length > 0 && (
              <Select
                aria-label="Link requirement"
                className="h-[36px] min-w-0 flex-1 text-[13px]"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') onChange({ requirements: [...draft.requirements, e.target.value] });
                }}
              >
                <option value="">Link a requirement…</option>
                {unlinked.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.key}
                    {r.title ? ` · ${r.title}` : ''}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" variant="secondary" onClick={() => setNewReqOpen(true)}>
              New requirement
            </Button>
          </div>
          <RequirementDialog
            projectKey={projectKey}
            open={newReqOpen}
            onOpenChange={setNewReqOpen}
            // The new requirement is linked to this case (saved with the case).
            onSaved={(key) => onChange({ requirements: [...draft.requirements, key] })}
          />
        </div>
      </Card>

      <Card aria-label="Parameters summary" className="flex flex-col gap-2.5 p-[18px] text-sm">
        <h2 className="text-[15px] font-semibold">Parameters</h2>
        {names.length === 0 ? (
          <p className="m-0 text-secondary">No parameters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[13px]">
              <thead>
                <tr className="text-secondary">
                  {names.map((n) => (
                    <th key={n} scope="col" className="py-1 pr-3 text-left font-medium">
                      {n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {draft.parameters.slice(0, 4).map((row, i) => (
                  <tr key={i}>
                    {names.map((n) => (
                      <td key={n} className="py-1 pr-3">
                        {String(row[n] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Link to={parametersHref as never} className="text-[13px] text-primary-text">
          Edit in Parameters tab
        </Link>
      </Card>

      <Card aria-label="Learned script summary" className="flex flex-col gap-2.5 p-[18px] text-sm">
        <h2 className="text-[15px] font-semibold">Learned script</h2>
        {learned.map((l) => {
          const s = learnedSummary(l, draft.steps.length);
          return (
            <div key={l.environmentId} className="flex items-center justify-between gap-2">
              <span>{l.environmentName}</span>
              {s.tone === 'plain' ? <span className="text-secondary">{s.label}</span> : <Pill tone={s.tone}>{s.label}</Pill>}
            </div>
          );
        })}
        <p className="m-0 text-[13px] text-secondary">Next run replays without model calls; S1 heals only changed steps.</p>
      </Card>
    </aside>
  );
}
