import * as Popover from '@radix-ui/react-popover';
import type { Precondition } from '@s1pilot/domain';
import { useState } from 'react';

import { parsePrecondition, preconditionLabel } from './model';

import { Button, Input, Tag } from '@/components/ui';

interface PreconditionStripProps {
  preconditions: Precondition[];
  onChange: (next: Precondition[]) => void;
}

/** Precondition tags (`flow: clear-cart`, `auth: none (guest)`) with an edit popover. */
export function PreconditionStrip({ preconditions, onChange }: PreconditionStripProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const parsed = parsePrecondition(text);
    if (!parsed) {
      setError('Write it as "flow: name" or "auth: name".');
      return;
    }
    onChange([...preconditions, parsed]);
    setText('');
    setError(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-control border border-dashed border-line-dashed bg-surface px-3.5 py-3 text-sm">
      <span className="text-xs uppercase tracking-[0.06em] text-secondary">Precondition</span>
      {preconditions.length === 0 && <span className="text-secondary">None</span>}
      {preconditions.map((p, i) => (
        <Tag key={`${preconditionLabel(p)}-${i}`} mono className="px-2.5 py-[3px] text-[13px]">
          {preconditionLabel(p)}
        </Tag>
      ))}
      <Popover.Root onOpenChange={() => setError(null)}>
        <Popover.Trigger asChild>
          <Button variant="secondary" size="sm" className="ml-auto">
            Edit preconditions
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            aria-label="Edit preconditions"
            className="z-30 flex w-[min(360px,calc(100vw-32px))] flex-col gap-3 rounded-card border border-line bg-surface p-4"
          >
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {preconditions.map((p, i) => (
                <li key={`${preconditionLabel(p)}-${i}`} className="flex items-center justify-between gap-2">
                  <Tag mono>{preconditionLabel(p)}</Tag>
                  <Button variant="secondary" size="sm" aria-label={`Remove ${preconditionLabel(p)}`} onClick={() => onChange(preconditions.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <label className="text-[13px] font-medium" htmlFor="precondition-input">
                Add precondition
              </label>
              <Input id="precondition-input" mono placeholder="flow: clear-cart" value={text} onChange={(e) => setText(e.target.value)} />
              {error !== null && (
                <span role="alert" className="text-xs text-danger">
                  {error}
                </span>
              )}
              <Button type="submit" variant="primary">
                Add
              </Button>
            </form>
            <Popover.Close asChild>
              <Button variant="secondary">Done</Button>
            </Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
