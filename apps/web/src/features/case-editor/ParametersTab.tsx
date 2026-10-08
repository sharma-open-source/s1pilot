import type { Parameters } from '@s1pilot/domain';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import { paramNames } from './model';

import { Button, Callout, EmptyState, Field, Input, Select } from '@/components/ui';

interface ParametersTabProps {
  parameters: Parameters;
  onChange: (rows: Parameters) => void;
}

const NAME_RE = /^[A-Za-z_][\w-]*$/;

/** Data-driven rows: columns are `{param}` names, each row is one run of the case. */
export function ParametersTab({ parameters, onChange }: ParametersTabProps) {
  const names = paramNames(parameters);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addColumn = () => {
    const name = newName.trim();
    if (!NAME_RE.test(name)) {
      setError('Use letters, digits, "_" or "-"; start with a letter or "_".');
      return;
    }
    if (names.includes(name)) {
      setError(`Parameter "${name}" already exists.`);
      return;
    }
    setError(null);
    setNewName('');
    onChange(parameters.length === 0 ? [{ [name]: '' }] : parameters.map((r) => ({ ...r, [name]: '' })));
  };

  const removeColumn = (name: string) => {
    const rows = parameters.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== name)));
    onChange(rows.every((r) => Object.keys(r).length === 0) ? [] : rows);
  };

  const setCell = (row: number, name: string, text: string) =>
    onChange(
      parameters.map((r, i) => {
        if (i !== row) return r;
        const prev = r[name];
        // keep numbers/booleans typed when the text still reads the same
        return { ...r, [name]: prev !== undefined && typeof prev !== 'string' && String(prev) === text ? prev : text };
      }),
    );

  const addRow = () => onChange([...parameters, Object.fromEntries(names.map((n) => [n, '']))]);

  return (
    <section aria-label="Parameters" className="flex flex-col gap-4">
      <p className="m-0 max-w-[70ch] text-sm text-secondary">
        Each row runs the case once. Use <span className="font-mono">{'{name}'}</span> in a step to insert the column value.
      </p>
      {names.length === 0 ? (
        <EmptyState>No parameters yet. Add a column below to make this case data-driven.</EmptyState>
      ) : (
        <div className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <caption className="sr-only">Parameter rows</caption>
            <thead>
              <tr className="bg-surface-subtle text-left text-xs font-medium uppercase tracking-[0.05em] text-secondary">
                <th scope="col" className="w-12 px-3.5 py-2.5 font-medium">
                  #
                </th>
                {names.map((n) => (
                  <th key={n} scope="col" className="px-2.5 py-2.5 font-mono font-medium normal-case tracking-normal">
                    <span className="inline-flex items-center gap-1">
                      {n}
                      <button
                        type="button"
                        aria-label={`Remove parameter ${n}`}
                        onClick={() => removeColumn(n)}
                        className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-tag border-0 bg-transparent text-secondary"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </span>
                  </th>
                ))}
                <th scope="col" className="w-12 px-2.5">
                  <span className="sr-only">Row actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {parameters.map((row, r) => (
                <tr key={r} className="border-t border-divider-row">
                  <td className="px-3.5 py-2 font-mono text-secondary">{r + 1}</td>
                  {names.map((n) => (
                    <td key={n} className="px-2.5 py-2">
                      <Input mono aria-label={`${n}, row ${r + 1}`} value={String(row[n] ?? '')} onChange={(e) => setCell(r, n, e.target.value)} />
                    </td>
                  ))}
                  <td className="px-2.5 py-2">
                    <button
                      type="button"
                      aria-label={`Delete row ${r + 1}`}
                      onClick={() => onChange(parameters.filter((_, i) => i !== r))}
                      className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-control border-0 bg-transparent text-danger"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {names.length > 0 && (
          <Button variant="dashed" className="min-h-[44px]" onClick={addRow}>
            + Add row
          </Button>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addColumn();
          }}
        >
          <Field label="New parameter">{(id) => <Input id={id} mono className="w-48" placeholder="colour" value={newName} onChange={(e) => setNewName(e.target.value)} />}</Field>
          <Button type="submit" variant="secondary">
            + Add parameter
          </Button>
        </form>
      </div>
      {error !== null && <Callout tone="danger">{error}</Callout>}
      <Field label="Dataset" hint="Linking a shared test data set arrives with the test data library; rows here are stored in the case.">
        {(id) => (
          <Select id={id} disabled className="max-w-xs" value="">
            <option value="">Inline rows (this case)</option>
          </Select>
        )}
      </Field>
    </section>
  );
}
