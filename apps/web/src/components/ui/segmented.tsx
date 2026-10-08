import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  className?: string;
}

/** Group of toggle buttons (`aria-pressed`); the pressed one is ink on white text. */
export function Segmented<T extends string>({ options, value, onChange, className, ...rest }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={rest['aria-label']} className={cn('inline-flex flex-wrap gap-1', className)}>
      {options.map((o) => {
        const pressed = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-[36px] rounded-tag border px-3 text-[13px]',
              pressed ? 'border-ink bg-ink font-semibold text-white' : 'border-line-input bg-surface font-medium text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
