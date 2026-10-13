import { z } from 'zod';

/** Wizard steps in order; the id is the `?step=` value. */
export const WIZARD_STEPS = [
  { id: 'basics', label: 'Basics' },
  { id: 'environments', label: 'Environments' },
  { id: 'models', label: 'Models' },
  { id: 'login', label: 'Login setup' },
  { id: 'first-tests', label: 'First tests' },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]['id'];

const STEP_IDS = WIZARD_STEPS.map((s) => s.id) as readonly string[];

/** Parses the `step` search param, defaulting to the first step. */
export function parseStep(raw: unknown): WizardStep {
  return typeof raw === 'string' && STEP_IDS.includes(raw) ? (raw as WizardStep) : 'basics';
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.findIndex((s) => s.id === step);
}

/** Step after `step`, or `null` on the last one. */
export function nextStep(step: WizardStep): (typeof WIZARD_STEPS)[number] | null {
  return WIZARD_STEPS[stepIndex(step) + 1] ?? null;
}

/** Step before `step`, or `null` on the first one. */
export function prevStep(step: WizardStep): (typeof WIZARD_STEPS)[number] | null {
  return WIZARD_STEPS[stepIndex(step) - 1] ?? null;
}

/** Same rule as `PROJECT_KEY_REGEX` in `@s1pilot/domain` (2 to 10 chars, uppercase letters/digits, letter first). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Derives a project key from a name: letters and digits only, uppercase, letter first, at most 10 characters. */
export function keyFromName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 10);
}

const url = z.string().trim().url('Enter a full URL, for example https://shop.example.com');

export const BasicsSchema = z.object({
  name: z.string().trim().min(1, 'Enter a project name'),
  key: z
    .string()
    .trim()
    .regex(
      PROJECT_KEY_RE,
      'Use 2 to 10 uppercase letters or digits, starting with a letter (for example SHOP)',
    ),
  baseUrl: url,
});
export type BasicsValues = z.infer<typeof BasicsSchema>;

export const EnvRowSchema = z.object({
  /** Server id once saved. */
  envId: z.string().optional(),
  name: z.string().trim().min(1, 'Enter a name'),
  baseUrl: url,
});
export type EnvRow = z.infer<typeof EnvRowSchema>;

export const EnvironmentsSchema = z
  .object({ rows: z.array(EnvRowSchema).min(1, 'Keep at least one environment') })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.rows.forEach((r, i) => {
      const n = r.name.trim().toLowerCase();
      if (seen.has(n))
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'name'],
          message: 'Names must be unique',
        });
      seen.add(n);
    });
  });
export type EnvironmentsValues = z.infer<typeof EnvironmentsSchema>;

/** Adapter choices in the System 1 select (wireframe order). `auto` probes for the adapter. */
export const S1_ADAPTERS = [
  { value: 'systemone', label: 'systemone · POST /v1/systemone' },
  { value: 'decide', label: 'decide · POST /v1/decide' },
  { value: 'openai-logprobs', label: 'openai-logprobs · /v1/chat/completions' },
  { value: 'auto', label: 'Auto-detect' },
] as const;
export type S1AdapterChoice = (typeof S1_ADAPTERS)[number]['value'];

/** Slider bounds: act 0.50-0.99, escalate 0.10-0.80, step 0.01. */
export const ACT_RANGE = { min: 0.5, max: 0.99 } as const;
export const ESCALATE_RANGE = { min: 0.1, max: 0.8 } as const;
const STEP = 0.01;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Allowed `act` range given the current `escalate` (act must stay above escalate). */
export function actBounds(escalate: number): { min: number; max: number } {
  return { min: Math.max(ACT_RANGE.min, round2(escalate + STEP)), max: ACT_RANGE.max };
}

/** Allowed `escalate` range given the current `act` (escalate must stay below act). */
export function escalateBounds(act: number): { min: number; max: number } {
  return { min: ESCALATE_RANGE.min, max: Math.min(ESCALATE_RANGE.max, round2(act - STEP)) };
}

/** Applies a change to one threshold and moves the other just enough to keep `escalate < act`. */
export function constrainThresholds(
  current: { act: number; escalate: number },
  change: Partial<{ act: number; escalate: number }>,
): { act: number; escalate: number } {
  let act = round2(Math.min(ACT_RANGE.max, Math.max(ACT_RANGE.min, change.act ?? current.act)));
  let escalate = round2(
    Math.min(ESCALATE_RANGE.max, Math.max(ESCALATE_RANGE.min, change.escalate ?? current.escalate)),
  );
  if (escalate >= act) {
    if (change.act !== undefined) escalate = round2(act - STEP);
    else act = round2(escalate + STEP);
  }
  return { act, escalate };
}

export interface ModelsValues {
  s1: { adapter: S1AdapterChoice; baseUrl: string; model: string; apiKey: string };
  s2: { baseUrl: string; model: string; apiKey: string };
  act: number;
  escalate: number;
  dualOrderSensitive: boolean;
  sendPageText: boolean;
  sendScreenshots: boolean;
}

export const DEFAULT_MODELS: ModelsValues = {
  s1: { adapter: 'systemone', baseUrl: '', model: '', apiKey: '' },
  s2: { baseUrl: '', model: '', apiKey: '' },
  act: 0.8,
  escalate: 0.5,
  dualOrderSensitive: true,
  sendPageText: true,
  sendScreenshots: false,
};

const optionalUrl = z.union([z.literal(''), url]);

export const ModelsSchema = z
  .object({
    s1: z.object({
      adapter: z.enum(['systemone', 'decide', 'openai-logprobs', 'auto']),
      baseUrl: optionalUrl,
      model: z.string().trim(),
      apiKey: z.string(),
    }),
    s2: z.object({ baseUrl: optionalUrl, model: z.string().trim(), apiKey: z.string() }),
    act: z.number(),
    escalate: z.number(),
    dualOrderSensitive: z.boolean(),
    sendPageText: z.boolean(),
    sendScreenshots: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.escalate >= v.act) {
      ctx.addIssue({
        code: 'custom',
        path: ['escalate'],
        message: 'Escalate must stay below the act threshold',
      });
    }
    if (v.s1.baseUrl !== '' && v.s1.model === '') {
      ctx.addIssue({ code: 'custom', path: ['s1', 'model'], message: 'Enter the model id' });
    }
    if (v.s2.baseUrl !== '' && v.s2.model === '') {
      ctx.addIssue({ code: 'custom', path: ['s2', 'model'], message: 'Enter the model id' });
    }
  });

/** An `env:NAME` / `secret:key` reference typed into a key field, or undefined for anything else (a pasted key). */
export function apiKeyRefFrom(input: string): string | undefined {
  const v = input.trim();
  return /^(env|secret):\S+$/.test(v) ? v : undefined;
}

/** True for the reference of a key the server stores encrypted (`secret:model/…`); the key itself never reaches the UI. */
export const isSavedKeyRef = (ref: string | undefined): boolean => ref?.startsWith('secret:model/') === true;

/** What the API key field of an endpoint shows: an `env:NAME` ref as text; a saved key only as "saved". */
export function keyFieldFrom(ref: string | undefined): { text: string; savedRef?: string } {
  if (ref !== undefined && isSavedKeyRef(ref)) return { text: '', savedRef: ref };
  return { text: ref ?? '' };
}

/**
 * How an API key field is saved: a typed reference becomes `apiKeyRef`; a pasted key goes to `apiKey` (the server
 * stores it encrypted); an empty field keeps the saved key unless `remove` is set, which sends `apiKey: null`.
 */
export function keyToSave(input: string, savedRef: string | undefined, remove = false): { apiKeyRef?: string; apiKey?: string | null } {
  const v = input.trim();
  if (v !== '') {
    const ref = apiKeyRefFrom(v);
    return ref !== undefined ? { apiKeyRef: ref } : { apiKey: v };
  }
  if (savedRef === undefined) return {};
  return remove ? { apiKey: null } : { apiKeyRef: savedRef };
}

/** Hint under an API key field. */
export const KEY_HINT = 'Paste the key to save it encrypted on the server, or enter env:NAME to read it from a server environment variable.';

/** Wizard draft; kept in sessionStorage until finish. Never holds API keys, only their references. */
export interface WizardDraft {
  basics: BasicsValues & { keyTouched: boolean };
  /** Project key once step 1 created the project. */
  createdKey?: string;
  envRows?: EnvRow[];
  models: Omit<ModelsValues, 's1' | 's2'> & {
    /** `keyRef`: saved `apiKeyRef` (`env:NAME`, or `secret:model/…` for a key stored encrypted on the server). */
    s1: Omit<ModelsValues['s1'], 'apiKey'> & { keyRef?: string };
    s2: Omit<ModelsValues['s2'], 'apiKey'> & { keyRef?: string };
  };
  login: { choice?: 'recorded' | 'flow' | 'skipped'; flowName: string };
  firstTest: string;
  /** Key of the draft case created in step 5. */
  caseKey?: string;
}

export const EMPTY_DRAFT: WizardDraft = {
  basics: { name: '', key: '', baseUrl: '', keyTouched: false },
  models: {
    act: DEFAULT_MODELS.act,
    escalate: DEFAULT_MODELS.escalate,
    dualOrderSensitive: DEFAULT_MODELS.dualOrderSensitive,
    sendPageText: DEFAULT_MODELS.sendPageText,
    sendScreenshots: DEFAULT_MODELS.sendScreenshots,
    s1: { adapter: DEFAULT_MODELS.s1.adapter, baseUrl: '', model: '' },
    s2: { baseUrl: '', model: '' },
  },
  login: { flowName: '' },
  firstTest: '',
};

export const DRAFT_STORAGE_KEY = 's1pilot.wizard.draft';

/** Reads the draft; falls back to an empty one when storage is unavailable or corrupt. */
export function loadDraft(): WizardDraft {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw === null) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<WizardDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      basics: { ...EMPTY_DRAFT.basics, ...parsed.basics },
      models: {
        ...EMPTY_DRAFT.models,
        ...parsed.models,
        s1: { ...EMPTY_DRAFT.models.s1, ...parsed.models?.s1 },
        s2: { ...EMPTY_DRAFT.models.s2, ...parsed.models?.s2 },
      },
      login: { ...EMPTY_DRAFT.login, ...parsed.login },
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(draft: WizardDraft): void {
  try {
    window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* storage unavailable: the draft only lives in memory */
  }
}

export function clearDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Subset of a project's saved settings the wizard can edit. */
export interface ExistingProject {
  key: string;
  name: string;
  baseUrl: string;
  settings: {
    system1?: { adapter?: string; baseUrl?: string; model?: string; apiKeyRef?: string };
    system2?: { baseUrl?: string; model?: string; apiKeyRef?: string };
    thresholds?: { act?: number; escalate?: number };
    dualOrderSensitive?: boolean;
  } | null;
  dataPolicy?: { sendPageText?: boolean; sendScreenshots?: string };
}

/** Builds a draft from a saved project so "Project setup" edits it instead of starting over. Key references are kept; keys are never loaded. */
export function draftFromProject(p: ExistingProject): WizardDraft {
  const s = p.settings ?? {};
  const adapter = s.system1?.adapter;
  return {
    ...EMPTY_DRAFT,
    basics: { name: p.name, key: p.key, baseUrl: p.baseUrl, keyTouched: true },
    createdKey: p.key,
    models: {
      act: s.thresholds?.act ?? DEFAULT_MODELS.act,
      escalate: s.thresholds?.escalate ?? DEFAULT_MODELS.escalate,
      dualOrderSensitive: s.dualOrderSensitive ?? DEFAULT_MODELS.dualOrderSensitive,
      sendPageText: p.dataPolicy?.sendPageText ?? DEFAULT_MODELS.sendPageText,
      sendScreenshots: (p.dataPolicy?.sendScreenshots ?? 'never') !== 'never',
      s1: {
        adapter:
          adapter === 'systemone' || adapter === 'decide' || adapter === 'openai-logprobs'
            ? adapter
            : DEFAULT_MODELS.s1.adapter,
        baseUrl: s.system1?.baseUrl ?? '',
        model: s.system1?.model ?? '',
        ...(s.system1?.apiKeyRef !== undefined ? { keyRef: s.system1.apiKeyRef } : {}),
      },
      s2: {
        baseUrl: s.system2?.baseUrl ?? '',
        model: s.system2?.model ?? '',
        ...(s.system2?.apiKeyRef !== undefined ? { keyRef: s.system2.apiKeyRef } : {}),
      },
    },
  };
}
