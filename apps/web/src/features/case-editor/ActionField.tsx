import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { completionAt, splitParams } from './model';

import { cn } from '@/lib/cn';

/** Shared step offered by the `@` autocomplete. */
export interface SharedOption {
  id: string;
  name: string;
  params: string[];
  usageCount: number;
}

interface ActionFieldProps {
  /** Accessible name of the textarea. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Known parameter names; `{` suggests them and unknown `{x}` chips are flagged. */
  params: string[];
  /** Shared steps for `@`; omit to disable that trigger. */
  shared?: SharedOption[];
  onPickShared?: (option: SharedOption) => void;
  placeholder?: string;
  className?: string;
}

interface Option {
  key: string;
  label: string;
  hint?: string;
}

/**
 * Auto-growing plain-language field. `{param}` tokens are highlighted as chips (a mirrored layer under a
 * transparent textarea keeps the caret and the chips aligned); typing `{` suggests parameters and `@` suggests
 * shared steps.
 */
export function ActionField({ label, value, onChange, params, shared, onPickShared, placeholder, className }: ActionFieldProps) {
  const listId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const trigger = focused && !dismissed ? completionAt(value, caret) : undefined;
  let options: Option[] = [];
  if (trigger?.kind === 'param') {
    options = params.filter((p) => p.toLowerCase().includes(trigger.query.toLowerCase())).map((p) => ({ key: p, label: `{${p}}` }));
  } else if (trigger?.kind === 'shared' && shared !== undefined) {
    options = shared
      .filter((s) => s.name.toLowerCase().includes(trigger.query.toLowerCase()))
      .map((s) => ({ key: s.id, label: s.name, hint: `${s.usageCount} ${s.usageCount === 1 ? 'case' : 'cases'}` }));
  }
  const open = options.length > 0;
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const choose = (opt: Option) => {
    if (!trigger) return;
    if (trigger.kind === 'param') {
      const insert = opt.label;
      const after = value.slice(caret).replace(/^\}/, '');
      onChange(value.slice(0, trigger.start) + insert + after);
      pendingCaret.current = trigger.start + insert.length;
    } else {
      const found = shared?.find((s) => s.id === opt.key);
      if (found) onPickShared?.(found);
    }
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((activeIndex + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((activeIndex - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const opt = options[activeIndex];
      if (opt) choose(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
    }
  };

  return (
    <div className={cn('relative', className)}>
      <div className="relative min-h-[44px] rounded-tag border border-line-input bg-surface focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
        <div aria-hidden="true" className="min-h-[42px] whitespace-pre-wrap break-words px-2.5 py-2 text-sm leading-5 text-transparent">
          {splitParams(value).map((part, i) =>
            part.kind === 'param' ? (
              <span
                key={i}
                data-chip=""
                className={cn('rounded-tag', params.includes(part.value.slice(1, -1)) ? 'bg-warning-soft' : 'bg-danger-soft')}
              >
                {part.value}
              </span>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
          {'​'}
        </div>
        <textarea
          ref={ref}
          aria-label={label}
          value={value}
          placeholder={placeholder}
          rows={1}
          role={open ? 'combobox' : undefined}
          aria-expanded={open ? true : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
          aria-autocomplete={open ? 'list' : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(false);
            setActive(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="absolute inset-0 h-full w-full resize-none overflow-hidden border-0 bg-transparent px-2.5 py-2 text-sm leading-5 text-fg outline-none placeholder:text-muted"
        />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={trigger?.kind === 'param' ? 'Parameters' : 'Shared steps'}
          className="absolute left-0 top-full z-20 mt-1 max-h-48 w-full min-w-[200px] overflow-auto rounded-control border border-line bg-surface p-1 shadow-none"
        >
          {options.map((opt, i) => (
            <li
              key={opt.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(opt);
              }}
              className={cn(
                'flex min-h-[36px] cursor-pointer items-center justify-between gap-3 rounded-tag px-2.5 text-sm',
                trigger?.kind === 'param' && 'font-mono',
                i === activeIndex ? 'bg-primary-soft text-primary-text' : 'text-fg',
              )}
            >
              <span>{opt.label}</span>
              {opt.hint !== undefined && <span className="text-xs text-secondary">{opt.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
