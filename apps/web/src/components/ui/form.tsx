import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import { cn } from '@/lib/cn';

const control =
  'w-full rounded-control border border-line-input bg-surface px-3 text-sm text-fg placeholder:text-muted disabled:bg-surface-muted';

/** Single-line input, 44 px tall. Pass `mono` for URLs, keys, cron, queries and model ids. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...rest }, ref) {
    return <input ref={ref} className={cn(control, 'h-[44px]', mono && 'font-mono', className)} {...rest} />;
  },
);

/** Native select, 44 px tall. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { mono?: boolean }>(
  function Select({ className, mono, ...rest }, ref) {
    return <select ref={ref} className={cn(control, 'h-[44px]', mono && 'font-mono', className)} {...rest} />;
  },
);

/** Multi-line input. */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
>(function Textarea({ className, mono, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-[88px] py-2.5', mono && 'font-mono', className)} {...rest} />;
});

export interface FieldProps {
  label: string;
  /** Render-prop receives the generated control id so the `<label>` is associated. */
  children: (id: string) => ReactNode;
  hint?: ReactNode;
  className?: string;
}

/** Label column: 13/500 label, 6 px gap, control below. */
export function Field({ label, children, hint, className }: FieldProps) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {hint !== undefined && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

/** Native checkbox with a label to its right. */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }>(
  function Checkbox({ label, className, ...rest }, ref) {
    return (
      <label className={cn('inline-flex min-h-[36px] items-center gap-2.5 text-sm text-fg', className)}>
        <input ref={ref} type="checkbox" className="h-[18px] w-[18px] accent-primary" {...rest} />
        <span>{label}</span>
      </label>
    );
  },
);

export interface RangeProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Formatted value readout; defaults to the value with 2 decimals. */
  format?: (value: number) => string;
}

/** Slider with a mono value readout on the right (`0.80`). */
export const Range = forwardRef<HTMLInputElement, RangeProps>(function Range(
  { className, format = (n) => n.toFixed(2), value, defaultValue, ...rest },
  ref,
) {
  const shown = Number(value ?? defaultValue ?? 0);
  return (
    <div className="flex items-center gap-3">
      <input
        ref={ref}
        type="range"
        className={cn('h-[44px] flex-1 accent-primary', className)}
        value={value}
        defaultValue={defaultValue}
        {...rest}
      />
      <output className="min-w-[3ch] text-right font-mono text-sm text-fg">{format(shown)}</output>
    </div>
  );
});
