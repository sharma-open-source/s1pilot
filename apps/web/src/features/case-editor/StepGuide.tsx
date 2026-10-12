import { useState } from 'react';

import { Card } from '@/components/ui';

/** One kind of step and how to word it. */
interface GuideRow {
  what: string;
  examples: string[];
  note?: string;
}

interface GuideGroup {
  title: string;
  rows: GuideRow[];
}

/** Wording the engine understands; kept in step with the engine's step-intent and wait parsing. */
export const STEP_GUIDE: GuideGroup[] = [
  {
    title: 'Clicking and typing',
    rows: [
      { what: 'Click a button or link', examples: ['Click "Add to cart"', 'Open the "Form Elements" page'], note: 'Use the text shown on the page.' },
      {
        what: 'Type exact text',
        examples: ['Type "js" in the Search box', 'Enter "Alex Doe" as the full name'],
        note: 'Put the text to type in double quotes. Without quotes the value comes from the Inputs column.',
      },
      {
        what: 'Use test data or a secret',
        examples: ['Log in with the customer email and password'],
        note: 'List the keys in the Inputs column (e.g. email, customer_password). Never write a password in the step.',
      },
      { what: 'Use a parameter', examples: ['Search for "{product}"'], note: 'Placeholders in {braces} are filled from each Parameters row.' },
      { what: 'Clear a field', examples: ['Clear the Search box'] },
    ],
  },
  {
    title: 'Choosing values',
    rows: [
      { what: 'Dropdown', examples: ['Select "India" in Country', 'Select "Red" and "Blue" in Colours'] },
      { what: 'Checkbox, switch, radio', examples: ['Tick "I agree to the terms"', 'Turn off "Autoplay"', 'Choose size "M"'] },
      { what: 'Date and time', examples: ['Set Date of birth to "1990-05-21"', 'Set the meeting time to "14:30"'] },
      { what: 'Slider', examples: ['Set volume to 90'] },
      { what: 'Colour', examples: ['Set the colour picker to "#ff0000"', 'Pick colour "red"'] },
      { what: 'Upload a file', examples: ['Upload "resume.pdf" to the Resume field'], note: 'A small sample file with that name is generated.' },
    ],
  },
  {
    title: 'Keyboard and mouse',
    rows: [
      { what: 'Press a key', examples: ['Press Enter', 'Press Ctrl+A', 'Press the Arrow Down key'] },
      { what: 'Hover', examples: ['Hover over "Products"'] },
      { what: 'Double or right click', examples: ['Double click "Edit"', 'Right click the first row'] },
      { what: 'Drag and drop', examples: ['Drag "Task 1" onto "Done"'] },
    ],
  },
  {
    title: 'Waiting',
    rows: [
      { what: 'Fixed pause', examples: ['Wait 5 seconds', 'Wait 500 ms'], note: 'Up to 5 minutes. Prefer waiting for something to appear.' },
      {
        what: 'Until text appears',
        examples: ['Wait until "Upload complete" appears', 'Wait until "Report ready" appears, up to 60 seconds'],
        note: 'Waits 30 seconds unless you give a limit; the step fails if the text never shows.',
      },
      { what: 'Until text disappears', examples: ['Wait until "Loading" disappears'] },
      { what: 'Page load', examples: ['Wait for the page to load'] },
    ],
  },
];

/** General advice shown under the table. */
export const STEP_TIPS = [
  'One goal per step, and include the action that moves the flow on ("Fill the shipping form and click Continue").',
  'Write what should be true afterwards in Expected, e.g. "The cart badge shows 1".',
  'Wait steps must start with "Wait"; "Click Save and wait" is treated as a normal step.',
];

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
