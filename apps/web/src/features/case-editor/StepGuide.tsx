import { STEP_GUIDE, STEP_TIPS } from '@s1pilot/domain/step-guide';
import { useState } from 'react';

import { Card } from '@/components/ui';

interface StepGuideProps {
  /** Show the guide expanded (new, empty cases). */
  defaultOpen?: boolean;
}

/** Collapsible "How to write steps" reference under the step grid. */
export function StepGuide({ defaultOpen = false }: StepGuideProps) {
  // Only the first render decides: typing the first step must not snap the guide shut.
  const [initiallyOpen] = useState(defaultOpen);
  return (
    <Card aria-label="How to write steps" className="text-sm">
      <details open={initiallyOpen}>
        <summary className="flex min-h-[44px] cursor-pointer items-center px-[18px] text-[15px] font-semibold">How to write steps</summary>
        <div className="flex flex-col gap-4 border-t border-divider px-[18px] pb-[18px] pt-3">
          {STEP_GUIDE.map((group) => (
            <div key={group.title} className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[13px] font-semibold uppercase tracking-wide text-secondary">{group.title}</h3>
              <dl className="m-0 flex flex-col">
                {group.rows.map((row) => (
                  <div key={row.what} className="flex flex-wrap gap-x-4 gap-y-1 border-b border-divider py-2 last:border-b-0">
                    <dt className="w-full font-medium sm:w-[180px] sm:shrink-0">{row.what}</dt>
                    <dd className="m-0 flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap gap-1.5">
                        {row.examples.map((ex) => (
                          <code key={ex} className="break-words rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-[13px]">
                            {ex}
                          </code>
                        ))}
                      </span>
                      {row.note && <span className="text-[13px] text-secondary">{row.note}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-secondary">
            {STEP_TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      </details>
    </Card>
  );
}
