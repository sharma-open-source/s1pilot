import type { KnownValues, VariableProposal } from './types.js';

/** `Full name` to `full_name`; falls back to `value`. */
export function variableKeyFor(field: string): string {
  const key = field
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return key || 'value';
}

/**
 * Turns typed values into references. An exact match with a known non-secret variable becomes
 * `var:<key>`; anything else becomes a new variable proposal. Secret fields (the page never sends
 * their value) become `secret:<key>`, reusing a known secret of that name or proposing a new one the
 * user has to fill in. No secret value ever passes through here.
 */
export class ValueMapper {
  private readonly byKey = new Map<string, VariableProposal>();

  constructor(private readonly known: KnownValues = { vars: {}, secretKeys: [] }) {}

  /** Reference for a typed (or chosen) `value` in the field called `field`. */
  mapValue(field: string, value: string): { valueRef: string; key: string } {
    for (const [key, v] of Object.entries(this.known.vars)) {
      if (v === value) return { valueRef: `var:${key}`, key };
    }
    for (const p of this.byKey.values()) {
      if (!p.secret && p.value === value) return { valueRef: `var:${p.key}`, key: p.key };
    }
    const base = variableKeyFor(field);
    let key = base;
    for (let n = 2; key in this.known.vars || this.known.secretKeys.includes(key) || this.byKey.has(key); n++) key = `${base}_${n}`;
    this.byKey.set(key, { key, value, secret: false, field });
    return { valueRef: `var:${key}`, key };
  }

  /** Reference for a secret field; the value is unknown by design. */
  mapSecret(field: string): { valueRef: string; key: string } {
    const key = variableKeyFor(field);
    if (!this.known.secretKeys.includes(key) && !this.byKey.has(key)) {
      this.byKey.set(key, { key, secret: true, field });
    }
    return { valueRef: `secret:${key}`, key };
  }

  /** Variables to create, in the order they were first needed. */
  proposals(): VariableProposal[] {
    return [...this.byKey.values()].map((p) => ({ ...p }));
  }
}
