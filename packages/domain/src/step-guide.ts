/**
 * How to word test steps so the engine understands them: shown to people on the test case page and
 * given to System 2 when it writes steps (test generation, recorder). Keep it in line with the
 * engine's step-intent, quoted-value and wait parsing.
 */

/** One kind of step and how to word it. */
export interface StepGuideRow {
  what: string;
  examples: string[];
  note?: string;
}

/** A titled group of {@link StepGuideRow}s. */
export interface StepGuideGroup {
  title: string;
  rows: StepGuideRow[];
}

export const STEP_GUIDE: StepGuideGroup[] = [
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

/** General advice shown under the guide. */
export const STEP_TIPS: string[] = [
  'One goal per step, and include the action that moves the flow on ("Fill the shipping form and click Continue").',
  'Write what should be true afterwards in Expected, e.g. "The cart badge shows 1".',
  'Wait steps must start with "Wait"; "Click Save and wait" is treated as a normal step.',
];

/** Rules for a model writing steps; the examples of {@link STEP_GUIDE} are appended by {@link stepGuidePrompt}. */
export const STEP_WRITING_RULES: string[] = [
  'Write each step as one short imperative sentence a tester can follow in a browser: one goal per step, including the action that moves the flow on (write "Fill the shipping form and click Continue", not just "Fill the shipping form").',
  'Name controls by the text shown on the page.',
  'Put every exact value to type, select, set, upload or wait for in double quotes ("js", "India", "1990-05-21", "resume.pdf").',
  'Use the wording of the examples below for keys, hover, double or right click, drag and drop, clearing, turning things off, dates, sliders, colours and uploads.',
  'A wait step starts with "Wait": "Wait 5 seconds", "Wait until "Saved" appears", "Wait until "Loading" disappears", "Wait for the page to load". Prefer waiting for text over a fixed pause.',
  '"expected" is what should be true afterwards, checkable on the page; leave it out when nothing is checked.',
  'Never write passwords, secrets or real personal data in a step.',
];

/** Options of {@link stepGuidePrompt}. */
export interface StepGuidePromptOptions {
  /**
   * Test data keys the steps may use (names only, never values). When given, the prompt explains the
   * step `inputs` list; when empty, it asks for quoted example values instead.
   */
  inputKeys?: readonly string[];
}

/** {@link STEP_WRITING_RULES}, the test data rule and the guide's examples as one prompt section. */
export function stepGuidePrompt(opts: StepGuidePromptOptions = {}): string {
  const keys = opts.inputKeys ?? [];
  const data =
    keys.length > 0
      ? `Test data keys available: ${keys.join(', ')}. When a step needs one of them (a login email, a password, an address), do not quote a value: describe the field ("Log in with the customer email and password") and list the keys in the step's "inputs". Use only these keys; for any other value, quote a realistic, non-sensitive example.`
      : 'No test data keys are defined: quote a realistic, non-sensitive example value (for example "alex@example.com") and leave "inputs" out.';
  return [...STEP_WRITING_RULES, data, stepGuideExamples()].join('\n');
}

/** The guide's examples as prompt lines ("Examples of step wording:" then one `- what: a | b` line per row). */
export function stepGuideExamples(): string {
  return ['Examples of step wording:', ...STEP_GUIDE.flatMap((g) => g.rows.map((r) => `- ${r.what}: ${r.examples.join(' | ')}`))].join('\n');
}
