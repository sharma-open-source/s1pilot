import { repos, type Db } from '@s1pilot/db';
import { S1PilotError, type ModelSettings } from '@s1pilot/domain';

/** Which endpoint of a model settings record a key belongs to. */
export type ModelKeySlot = 's1' | 's2';

/** API keys decrypted from `secret:model/…` references, by endpoint. Never log, store or send these. */
export interface ModelSecrets {
  s1?: string;
  s2?: string;
}

const REF_PREFIX = 'secret:model/';

/** `workspace` or the project id: whose settings an encrypted model key belongs to. */
export type ModelKeyOwner = string;

/** Reference saved in `apiKeyRef` for a key stored encrypted in the database (never the key itself). */
export const modelSecretRef = (owner: ModelKeyOwner, slot: ModelKeySlot): string => `${REF_PREFIX}${owner}/${slot}`;

/** Settings row holding the encrypted key. */
const storageKey = (owner: ModelKeyOwner, slot: ModelKeySlot): string => `model.apiKey.${owner}.${slot}`;

/** True for references to a key stored encrypted by {@link storeModelKey}. */
export const isModelSecretRef = (ref: string | undefined): boolean => ref?.startsWith(REF_PREFIX) === true;

function parseRef(ref: string): { owner: string; slot: ModelKeySlot } | undefined {
  const m = /^secret:model\/([^/]+)\/(s1|s2)$/.exec(ref);
  return m ? { owner: m[1] as string, slot: m[2] as ModelKeySlot } : undefined;
}

/** Encrypts `apiKey` with the database vault and stores it; returns the reference to save in `apiKeyRef`. */
export async function storeModelKey(db: Db, owner: ModelKeyOwner, slot: ModelKeySlot, apiKey: string): Promise<string> {
  await repos.settings.set(db, storageKey(owner, slot), { ciphertext: db.crypto.encrypt(apiKey) });
  return modelSecretRef(owner, slot);
}

/** Deletes a stored key (no-op when none is stored). */
export async function deleteModelKey(db: Db, owner: ModelKeyOwner, slot: ModelKeySlot): Promise<void> {
  await repos.settings.delete(db, storageKey(owner, slot));
}

/** Decrypts the key a `secret:model/…` reference points to, or undefined when it is not stored. */
export async function readModelKey(db: Db, ref: string): Promise<string | undefined> {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  const raw = (await repos.settings.get(db, storageKey(parsed.owner, parsed.slot))) as { ciphertext?: unknown } | undefined;
  return typeof raw?.ciphertext === 'string' ? db.crypto.decrypt(raw.ciphertext) : undefined;
}

/**
 * Decrypts the stored keys referenced by `settings` (only `secret:model/…` refs; `env:` refs are read later from
 * the environment). Throws `MISSING_SECRET` when a referenced key is gone, so a run fails with a clear message.
 */
export async function loadModelSecrets(db: Db, settings: ModelSettings | null | undefined): Promise<ModelSecrets> {
  const out: ModelSecrets = {};
  for (const [slot, ref] of [['s1', settings?.system1.apiKeyRef], ['s2', settings?.system2?.apiKeyRef]] as const) {
    if (ref === undefined || !isModelSecretRef(ref)) continue;
    const key = await readModelKey(db, ref);
    if (key === undefined) {
      throw new S1PilotError('MISSING_SECRET', 'The saved API key could not be found. Enter the key again in the model settings.', { slot });
    }
    out[slot] = key;
  }
  return out;
}
