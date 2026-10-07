import { S1PilotError } from './errors.js';

/** Removes secrets and sensitive-looking values from text and structured data. */
export interface Redactor {
  /** Replaces every sensitive occurrence in `text`. */
  redact(text: string): string;
  /** Returns a deep copy of `value` with every string redacted (cycle-safe). */
  redactDeep<T>(value: T): T;
}

export interface RedactorOptions {
  /** Resolved secret values; removed everywhere, including URL-encoded forms. */
  secrets: string[];
  /** Project `redactPatterns` (regex source strings, applied globally). */
  patterns: string[];
  /** Built-in detectors (emails, card numbers, tokens, API keys). Default: true. */
  builtins?: boolean;
}

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 20;

/** Luhn checksum over a string of digits. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Spellings under which a secret may leak: raw and percent/form-encoded (either hex case). */
function secretVariants(secret: string): string[] {
  const percent = encodeURIComponent(secret);
  const variants = new Set([
    secret,
    percent,
    percent.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    percent.replace(/%20/g, '+'),
    encodeURI(secret),
  ]);
  return [...variants].filter((v) => v.length > 0);
}

interface Builtin {
  kind: string;
  regex: RegExp;
  /** Return false to leave the match alone (false-positive guard). */
  accept?: (match: string) => boolean;
}

const BUILTINS: Builtin[] = [
  { kind: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g },
  { kind: 'bearer', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    kind: 'api-key',
    regex:
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
  },
  {
    kind: 'api-key',
    regex: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/gi,
  },
  { kind: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  {
    kind: 'card',
    regex: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (m) => luhn(m.replace(/[ -]/g, '')),
  },
];

function compilePattern(source: string): RegExp {
  try {
    return new RegExp(source, 'g');
  } catch {
    throw new S1PilotError('INVALID_REDACT_PATTERN', `Invalid redact pattern: ${source}`, { pattern: source });
  }
}

/**
 * Builds a redactor from secret values, project patterns and (by default) built-in detectors.
 * Secrets are replaced with `[REDACTED]`, built-ins with `[REDACTED:<kind>]`.
 */
export function createRedactor(opts: RedactorOptions): Redactor {
  // Longest first so a secret containing another secret is removed whole.
  const literals = [...new Set(opts.secrets.flatMap(secretVariants))].sort((a, b) => b.length - a.length);
  const patterns = opts.patterns.map(compilePattern);
  const builtins = opts.builtins === false ? [] : BUILTINS;

  function redact(text: string): string {
    let out = text;
    for (const literal of literals) {
      if (out.includes(literal)) out = out.split(literal).join(REDACTED);
    }
    for (const pattern of patterns) out = out.replace(pattern, REDACTED);
    for (const { kind, regex, accept } of builtins) {
      out = out.replace(regex, (match) => (accept && !accept(match) ? match : `[REDACTED:${kind}]`));
    }
    return out;
  }

  function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return redact(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    if (depth > MAX_DEPTH) return '[MaxDepth]';
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      result = value.map((item) => walk(item, depth + 1, seen));
    } else if (value instanceof Error) {
      result = {
        name: value.name,
        message: redact(value.message),
        ...(value.stack !== undefined ? { stack: redact(value.stack) } : {}),
      };
    } else {
      result = Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1, seen)]),
      );
    }
    seen.delete(value);
    return result;
  }

  return {
    redact,
    redactDeep: <T>(value: T): T => walk(value, 0, new WeakSet()) as T,
  };
}
