import type { BrowserTarget, SensitiveAction } from '@s1pilot/domain';

import type { RouterOutputs } from '@/lib/trpc';

/** Environment as returned by the server (secret values masked). */
export type MaskedEnv = RouterOutputs['environments']['get'];

/** How a variable row is stored. */
export type VarKind = 'variable' | 'secret-encrypted' | 'secret-env';

export const VAR_KIND_LABEL: Record<VarKind, string> = {
  variable: 'Variable',
  'secret-encrypted': 'Secret · encrypted',
  'secret-env': 'Secret · env',
};

/** One editable row of the variables table. */
export interface VarRow {
  /** Stable React key. */
  rid: string;
  key: string;
  kind: VarKind;
  /** Inline value; for an existing secret this is only a *replacement* (empty = keep). */
  value: string;
  /** Host env var name (`secret-env`, or a variable sourced from env). */
  envVar: string;
  /** `inline` or `env` (non-secret variables can come from the host environment). */
  source: 'inline' | 'env';
  /** Row came from the server (existing secrets keep their key and stored value). */
  existing: boolean;
}

/** Editable copy of the environment fields shown on the page. */
export interface EnvForm {
  baseUrl: string;
  allowDomains: string[];
  /** Preset id `browser|device`. */
  browser: string;
  /** Preset id `locale|timezone`. */
  localeTz: string;
  readOnly: boolean;
  requireApprovalFor: SensitiveAction[];
  variables: VarRow[];
}

export const ALL_SENSITIVE: SensitiveAction[] = ['pay', 'delete', 'send'];

/** Browser x viewport presets of the "Default browser" select. */
export const BROWSER_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'chromium|', label: 'Chromium · 1280×800' },
  { id: 'firefox|', label: 'Firefox · 1280×800' },
  { id: 'webkit|', label: 'WebKit · 1280×800' },
  { id: 'chromium|Pixel 7', label: 'Chromium · Pixel 7 (412×915)' },
  { id: 'webkit|iPhone 13', label: 'WebKit · iPhone 13 (390×844)' },
  { id: 'webkit|iPad (gen 7)', label: 'WebKit · iPad (810×1080)' },
];

/** Locale and timezone presets. */
export const LOCALE_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'en-US|UTC', label: 'en-US · UTC' },
  { id: 'en-US|America/New_York', label: 'en-US · America/New_York' },
  { id: 'en-GB|Europe/London', label: 'en-GB · Europe/London' },
  { id: 'de-DE|Europe/Berlin', label: 'de-DE · Europe/Berlin' },
  { id: 'en-IN|Asia/Kolkata', label: 'en-IN · Asia/Kolkata' },
  { id: 'ja-JP|Asia/Tokyo', label: 'ja-JP · Asia/Tokyo' },
];

/** Presets plus the current value when it is not one of them. */
export function withCurrent(presets: Array<{ id: string; label: string }>, id: string): Array<{ id: string; label: string }> {
  return presets.some((p) => p.id === id) ? presets : [...presets, { id, label: id.replace('|', ' · ').replace(/ · $/, '') }];
}

let ridCounter = 0;
/** New unique row id. */
export function newRid(): string {
  ridCounter += 1;
  return `v${ridCounter}`;
}

/** Builds the editable form from a server environment. */
export function formFromEnv(env: MaskedEnv): EnvForm {
  const first = env.browsers[0];
  return {
    baseUrl: env.baseUrl,
    allowDomains: [...env.allowDomains],
    browser: `${first?.browser ?? 'chromium'}|${first?.device ?? ''}`,
    localeTz: `${env.locale}|${env.timezone}`,
    readOnly: env.readOnly,
    requireApprovalFor: [...env.requireApprovalFor],
    variables: env.variables.map((v) => ({
      rid: newRid(),
      key: v.key,
      kind: v.secret ? (v.source === 'env' ? 'secret-env' : 'secret-encrypted') : 'variable',
      value: v.secret ? '' : (v.value ?? ''),
      envVar: v.envVar ?? '',
      source: v.source,
      existing: true,
    })),
  };
}

/** Splits a comma/space separated list into unique, trimmed domains. */
export function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((d) => d.trim()).filter((d) => d !== ''))];
}

const DOMAIN_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d+)?$/;

/** Inline validation errors by field. */
export interface FormErrors {
  baseUrl?: string;
  allowDomains?: string;
  variables: Record<string, { key?: string; value?: string; envVar?: string }>;
}

/** Validates the form; `ok` means it can be saved. */
export function validateForm(form: EnvForm): { ok: boolean; errors: FormErrors } {
  const errors: FormErrors = { variables: {} };
  try {
    const u = new URL(form.baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.baseUrl = 'Use an http:// or https:// URL';
  } catch {
    errors.baseUrl = 'Enter a valid URL, e.g. https://staging.shop.example';
  }
  const badDomain = form.allowDomains.find((d) => !DOMAIN_RE.test(d));
  if (badDomain !== undefined) errors.allowDomains = `"${badDomain}" is not a domain (no scheme or path, e.g. staging.shop.example)`;
  const seen = new Set<string>();
  for (const row of form.variables) {
    const e: { key?: string; value?: string; envVar?: string } = {};
    const key = row.key.trim();
    if (key === '') e.key = 'Key is required';
    else if (!/^[A-Za-z_][\w.-]*$/.test(key)) e.key = 'Use letters, digits, dot, dash or underscore';
    else if (seen.has(key)) e.key = 'Duplicate key';
    seen.add(key);
    if (row.kind === 'secret-env' || (row.kind === 'variable' && row.source === 'env')) {
      if (row.envVar.trim() === '') e.envVar = 'Host variable name is required';
    } else if (row.kind === 'secret-encrypted' && !row.existing && row.value === '') {
      e.value = 'Secret value is required';
    }
    if (Object.keys(e).length > 0) errors.variables[row.rid] = e;
  }
  const ok = errors.baseUrl === undefined && errors.allowDomains === undefined && Object.keys(errors.variables).length === 0;
  return { ok, errors };
}

/** Server variable shape for the update patch (secrets without `value` keep their stored value). */
export interface VariablePatch {
  key: string;
  secret: boolean;
  source: 'inline' | 'env';
  value?: string;
  envVar?: string;
}

function variablesOf(rows: VarRow[]): VariablePatch[] {
  return rows.map((r): VariablePatch => {
    if (r.kind === 'secret-env') return { key: r.key.trim(), secret: true, source: 'env', envVar: r.envVar.trim() };
    if (r.kind === 'secret-encrypted') {
      return { key: r.key.trim(), secret: true, source: 'inline', ...(r.value !== '' ? { value: r.value } : {}) };
    }
    return r.source === 'env'
      ? { key: r.key.trim(), secret: false, source: 'env', envVar: r.envVar.trim() }
      : { key: r.key.trim(), secret: false, source: 'inline', value: r.value };
  });
}

/** Fields of the `environments.update` patch. */
export interface EnvPatch {
  baseUrl?: string;
  allowDomains?: string[];
  browsers?: BrowserTarget[];
  locale?: string;
  timezone?: string;
  readOnly?: boolean;
  requireApprovalFor?: SensitiveAction[];
  variables?: VariablePatch[];
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Only the fields that differ from the saved environment. Empty object = clean. */
export function buildPatch(env: MaskedEnv, form: EnvForm): EnvPatch {
  const base = formFromEnv(env);
  const patch: EnvPatch = {};
  if (form.baseUrl.trim() !== base.baseUrl) patch.baseUrl = form.baseUrl.trim();
  if (!sameList(form.allowDomains, base.allowDomains)) patch.allowDomains = form.allowDomains;
  if (form.browser !== base.browser) {
    const [browser = 'chromium', device = ''] = form.browser.split('|');
    const next: BrowserTarget = { browser: browser as BrowserTarget['browser'], ...(device !== '' ? { device } : {}) };
    patch.browsers = [next, ...env.browsers.slice(1)];
  }
  if (form.localeTz !== base.localeTz) {
    const [locale = 'en-US', timezone = 'UTC'] = form.localeTz.split('|');
    patch.locale = locale;
    patch.timezone = timezone;
  }
  if (form.readOnly !== base.readOnly) patch.readOnly = form.readOnly;
  if (!sameList([...form.requireApprovalFor].sort(), [...base.requireApprovalFor].sort())) {
    patch.requireApprovalFor = form.requireApprovalFor;
  }
  if (JSON.stringify(variablesOf(form.variables)) !== JSON.stringify(variablesOf(base.variables))) {
    patch.variables = variablesOf(form.variables);
  }
  return patch;
}

/** "3 min ago" style label. */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined) return 'never';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Parsed upload for the preview dialog. */
export interface DatasetPreview {
  name: string;
  format: 'csv' | 'json';
  columns: string[];
  /** First 20 rows. */
  rows: string[][];
  totalRows: number;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** Parses a CSV or JSON (array of objects) file into a preview; throws an Error with a user-facing message. */
export function previewDataset(name: string, text: string): DatasetPreview {
  if (/\.json$/i.test(name)) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('This file is not valid JSON.');
    }
    if (!Array.isArray(data) || data.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))) {
      throw new Error('JSON data sets must be an array of objects.');
    }
    const objs = data as Array<Record<string, unknown>>;
    const columns = [...new Set(objs.flatMap((o) => Object.keys(o)))];
    const cell = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return { name, format: 'json', columns, rows: objs.slice(0, 20).map((o) => columns.map((c) => cell(o[c]))), totalRows: objs.length };
  }
  if (/\.csv$/i.test(name)) {
    const all = parseCsv(text);
    const [header, ...body] = all;
    if (header === undefined) throw new Error('This CSV file is empty.');
    return { name, format: 'csv', columns: header, rows: body.slice(0, 20), totalRows: body.length };
  }
  throw new Error('Choose a .csv or .json file.');
}
