import type { MatrixEntry } from '@s1pilot/domain';

import { Select } from '@/components/ui';
import { cellChecked, columnEntry, entryAllowed, MATRIX_COLUMNS, MOBILE_DEVICES, type MatrixBrowser, type PlanEnv } from '@/features/plans/model';

export interface MatrixTableProps {
  envs: PlanEnv[];
  matrix: MatrixEntry[];
  /** Device used by the Mobile column. */
  device: string;
  onToggle: (envId: string, column: MatrixBrowser) => void;
  onDevice: (device: string) => void;
}

/** Environments x browsers grid of checkboxes; read-only environments only enable the browsers they list. */
export function MatrixTable({ envs, matrix, device, onToggle, onDevice }: MatrixTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[520px] border-collapse text-sm">
        <caption className="sr-only">Environments and browsers to run on</caption>
        <thead>
          <tr className="text-xs uppercase tracking-[0.05em] text-muted">
            <th scope="col" className="py-2 pr-4 text-left font-medium">
              Environment
            </th>
            {MATRIX_COLUMNS.map((c) => (
              <th key={c.id} scope="col" className="px-4 py-2 font-medium">
                {c.id === 'mobile' ? (
                  <span className="inline-flex items-center gap-2">
                    Mobile
                    <Select
                      aria-label="Mobile device"
                      className="h-9 w-auto min-w-[110px] text-[13px] normal-case tracking-normal"
                      value={device}
                      onChange={(e) => onDevice(e.target.value)}
                    >
                      {MOBILE_DEVICES.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </span>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {envs.map((env) => (
            <tr key={env.id} className="border-t border-divider-row">
              <th scope="row" className="py-2.5 pr-4 text-left font-medium">
                {env.name}
                {env.readOnly && <span className="ml-1.5 text-xs font-normal text-danger">read-only</span>}
              </th>
              {MATRIX_COLUMNS.map((c) => {
                const allowed = entryAllowed(env, columnEntry(env.id, c.id, device));
                return (
                  <td key={c.id} className="text-center">
                    <label className="inline-flex h-11 w-11 items-center justify-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5 accent-primary"
                        aria-label={`${env.name} ${c.label}`}
                        checked={cellChecked(matrix, env.id, c.id, device)}
                        disabled={!allowed}
                        onChange={() => onToggle(env.id, c.id)}
                      />
                    </label>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
