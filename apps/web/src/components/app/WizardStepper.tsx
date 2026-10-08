import { cn } from '@/lib/cn';

export interface WizardStepperItem {
  id: string;
  label: string;
}

/**
 * Wizard progress: done steps show a check, the current step is an ink pill with `aria-current="step"`,
 * upcoming steps are dashed.
 */
export function WizardStepper({ steps, current }: { steps: readonly WizardStepperItem[]; current: string }) {
  const currentIndex = steps.findIndex((s) => s.id === current);
  return (
    <ol aria-label="Wizard steps" className="m-0 flex list-none flex-wrap gap-2 p-0">
      {steps.map((s, i) => {
        const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming';
        return (
          <li
            key={s.id}
            aria-current={state === 'current' ? 'step' : undefined}
            data-state={state}
            className={cn(
              'flex items-center gap-2 rounded-pill px-3.5 py-2 text-sm',
              state === 'done' && 'border border-line bg-surface text-fg',
              state === 'current' && 'bg-ink font-semibold text-white',
              state === 'upcoming' && 'border border-dashed border-line-dashed-strong text-secondary',
            )}
          >
            <span className={cn('font-mono', state === 'done' && 'font-semibold text-success')}>
              {state === 'done' ? '✓' : i + 1}
            </span>
            {s.label}
            {state === 'done' && <span className="sr-only"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}
