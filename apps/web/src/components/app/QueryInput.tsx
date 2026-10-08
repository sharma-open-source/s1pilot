import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

export interface QueryInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  /** Visible label inside the field (`Filter`). */
  label?: string;
  onChange: (value: string) => void;
}

/** Mono filter field with its label inside the box, bound to a case-query string (`tags:checkout AND priority<=P1`). */
export const QueryInput = forwardRef<HTMLInputElement, QueryInputProps>(function QueryInput(
  { label = 'Filter', onChange, className, ...rest },
  ref,
) {
  return (
    <label
      className={cn(
        'flex min-h-[44px] flex-[1_1_240px] items-center gap-2 rounded-control border border-line-input bg-surface px-3 text-sm text-muted',
        className,
      )}
    >
      {label}
      <input
        ref={ref}
        type="text"
        spellCheck={false}
        autoComplete="off"
        className="w-full min-w-0 border-0 bg-transparent font-mono text-[13px] text-fg outline-none"
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    </label>
  );
});
