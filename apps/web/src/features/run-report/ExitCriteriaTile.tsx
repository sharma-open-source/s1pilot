import { useState } from 'react';

import { StatTile } from '@/components/app/StatTile';
import { Pill } from '@/components/ui';

export interface ExitCriteriaView {
  met: number;
  total: number;
  items: Array<{ label: string; met: boolean; actual: string; detail: string }>;
}

export interface SignOffView {
  by: string;
  at: string;
  note: string;
}

/** "Exit criteria · x of n not met" tile with an expandable list of the evaluated criteria and the sign-off state. */
export function ExitCriteriaTile({ criteria, signOff }: { criteria: ExitCriteriaView | null | undefined; signOff?: SignOffView | null }) {
  const [open, setOpen] = useState(false);
  if (!criteria) return <StatTile label="Exit criteria" value="–" />;
  const unmet = criteria.total - criteria.met;
  return (
    <StatTile label="Exit criteria" value={`${unmet} of ${criteria.total} not met`} tone={unmet === 0 ? 'default' : 'danger'}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="exit-criteria-list"
        onClick={() => setOpen((o) => !o)}
        className="min-h-[44px] self-start text-sm text-primary underline"
      >
        {open ? 'Hide criteria' : 'Show criteria'}
      </button>
      {open && (
        <ul id="exit-criteria-list" aria-label="Exit criteria" className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
          {criteria.items.map((i) => (
            <li key={i.label} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <Pill tone={i.met ? 'success' : 'danger'}>{i.met ? 'Met' : 'Not met'}</Pill>
                <span>{i.label}</span>
              </span>
              <span className="text-muted">
                <span className="font-mono">{i.actual}</span> · {i.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      {signOff && (
        <div className="text-[13px] text-secondary">
          Signed off by <span className="font-mono">{signOff.by}</span>
          {signOff.note ? `: ${signOff.note}` : ''}
        </div>
      )}
    </StatTile>
  );
}
