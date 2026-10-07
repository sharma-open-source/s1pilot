# S-004 · Secrets vault & redaction

**Phase:** P0 · **Depends on:** S-002 · **Packages:** `@s1pilot/domain` (redaction), `@s1pilot/db` (vault) · **Plan refs:** §6 text input, §7 guards, §10 Secrets, §13

## Goal
Secrets are encrypted at rest, resolvable at run time only, and redacted from everything sent to models, logs and traces.

## Scope
- `packages/db/src/vault.ts`: libsodium (`libsodium-wrappers`) secretbox. Master key from `S1P_MASTER_KEY` (base64 32 bytes) or generated on first start into `~/.s1pilot/master.key` (0600). API: `encrypt(plain) → string`, `decrypt(cipher) → string`, `rotate(oldKey, newKey)` helper.
- Variable resolution `resolveVariables(env, { vault, processEnv })` → `ResolvedVars` with `get(key)`, `isSecret(key)`, `publicView()` (secrets replaced by `«secret:key»`).
- `packages/domain/src/redact.ts`: `Redactor` built from (a) resolved secret values, (b) project `redactPatterns` (regex strings), (c) built-ins: emails, card numbers (Luhn-checked 13–19 digits), bearer/JWT tokens, API-key-like strings. `redact(text)`, `redactDeep(obj)`.
- Pino logger hook uses `redactDeep`.

## Interfaces
```ts
export interface Vault { encrypt(p: string): string; decrypt(c: string): string }
export interface ResolvedVars { get(k: string): string | undefined; isSecret(k: string): boolean; keys(): string[]; publicView(): Record<string,string> }
export function createRedactor(opts: { secrets: string[]; patterns: string[]; builtins?: boolean }): Redactor
```

## Acceptance criteria
- [ ] Encrypt→decrypt round-trips; wrong key throws `S1PilotError('VAULT_DECRYPT')`.
- [ ] `source: env` variables read from `process.env[envVar]`; missing env var gives a clear error naming the key (not the value).
- [ ] `redact()` removes every secret value occurring anywhere in a string, including URL-encoded forms.
- [ ] Logging an object containing a secret value never prints it (test with pino destination stream).

## Tests
- Unit tests for vault, resolution, redactor patterns (positive + false-positive cases).

## Out of scope
- Screenshot/video pixel masking (S-035), UI reveal (S-042).
