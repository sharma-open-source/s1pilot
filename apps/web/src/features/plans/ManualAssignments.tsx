import { CASE_EXECUTION_OPTIONS, executionOf, setAssignment, type CaseAssignment, type CaseExecution } from './model';

import { Select } from '@/components/ui';
import { trpc } from '@/lib/trpc';

interface PreviewCase {
  id: string;
  key: string;
  title: string;
}

/**
 * Per-case execution choice (automated / manual / hybrid) and assignee (S-055). Manual and hybrid cases land in the
 * assignee's Manual testing queue when the plan runs; hybrid ones get an AI pre-run first.
 */
export function ManualAssignments({
  cases,
  assignments,
  onChange,
}: {
  /** Cases the selection currently matches (the preview's first 200). */
  cases: PreviewCase[];
  assignments: Record<string, CaseAssignment>;
  onChange: (next: Record<string, CaseAssignment>) => void;
}) {
  const users = trpc.users.options.useQuery(undefined, { staleTime: 60_000 });
  const manualCount = cases.filter((c) => executionOf(assignments[c.id]) !== 'automated').length;
  return (
    <details className="group rounded-card border border-line" open={manualCount > 0 ? true : undefined}>
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 px-4 text-sm font-medium text-fg">
        <span>Manual testing</span>
        <span className="text-[13px] font-normal text-secondary">
          {manualCount === 0 ? 'All cases automated' : `${manualCount} of ${cases.length} ${cases.length === 1 ? 'case' : 'cases'} manual`}
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-divider p-4">
        <p className="m-0 text-[13px] text-secondary">
          Manual and hybrid cases go to the assignee&apos;s Manual testing queue when the plan runs. Hybrid cases are pre-run by the AI first so the tester
          only confirms or redoes steps.
        </p>
        {cases.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">Select cases in section 1 to choose which ones are tested manually.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-divider-row p-0 text-sm">
            {cases.map((c) => {
              const a = assignments[c.id];
              const execution = executionOf(a);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                  <span className="font-mono text-[13px]">{c.key}</span>
                  <span className="min-w-0 flex-[1_1_160px] truncate">{c.title}</span>
                  <Select
                    aria-label={`Execution for ${c.key}`}
                    value={execution}
                    className="w-auto text-[13px]"
                    onChange={(e) => onChange(setAssignment(assignments, c.id, { execution: e.target.value as CaseExecution }))}
                  >
                    {CASE_EXECUTION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  {execution !== 'automated' && (
                    <Select
                      aria-label={`Assignee for ${c.key}`}
                      value={a?.assignee ?? ''}
                      className="w-auto text-[13px]"
                      onChange={(e) => onChange(setAssignment(assignments, c.id, { assignee: e.target.value }))}
                    >
                      <option value="">Whoever runs the plan</option>
                      {(users.data ?? []).map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
