import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { S1PilotError } from '@s1pilot/domain';
import { isNotNull, eq } from 'drizzle-orm';
import sodium from 'libsodium-wrappers';

import { atomic, type Db } from './db.js';
import { variables } from './schema/index.js';

/** Symmetric encryption for secret values at rest. Structurally a `SecretCrypto`. */
export interface Vault {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export interface VaultOptions {
  /** Base64-encoded 32-byte master key. Highest priority. */
  masterKey?: string;
  /** Environment to read `S1P_MASTER_KEY` from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Key file used (and created, mode 0600) when no key is configured. Default: `~/.s1pilot/master.key`. */
  keyFile?: string;
}

const PREFIX = 'v1:';

/** Generates a new base64 master key (32 random bytes). */
export async function generateMasterKey(): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES), sodium.base64_variants.ORIGINAL);
}

function parseKey(base64: string, source: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = sodium.from_base64(base64.trim(), sodium.base64_variants.ORIGINAL);
  } catch {
    throw new S1PilotError('VAULT_KEY_INVALID', `Master key from ${source} is not valid base64`);
  }
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new S1PilotError(
      'VAULT_KEY_INVALID',
      `Master key from ${source} must be ${sodium.crypto_secretbox_KEYBYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

async function loadOrCreateKeyFile(path: string): Promise<string> {
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    return readFileSync(path, 'utf8');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = await generateMasterKey();
  try {
    writeFileSync(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (error) {
    // Another process created it first: use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(path, 'utf8');
    throw error;
  }
}

/**
 * Creates a vault (libsodium secretbox). The master key comes from `opts.masterKey`,
 * then `S1P_MASTER_KEY`, then a key file that is generated on first start.
 */
export async function createVault(opts: VaultOptions = {}): Promise<Vault> {
  await sodium.ready;
  const env = opts.env ?? process.env;
  const configured = opts.masterKey ?? env['S1P_MASTER_KEY'];
  const key =
    configured !== undefined && configured !== ''
      ? parseKey(configured, opts.masterKey !== undefined ? 'options' : 'S1P_MASTER_KEY')
      : parseKey(
          await loadOrCreateKeyFile(opts.keyFile ?? join(homedir(), '.s1pilot', 'master.key')),
          'key file',
        );

  return {
    encrypt(plain) {
      const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
      const box = sodium.crypto_secretbox_easy(sodium.from_string(plain), nonce, key);
      const blob = new Uint8Array(nonce.length + box.length);
      blob.set(nonce);
      blob.set(box, nonce.length);
      return PREFIX + sodium.to_base64(blob, sodium.base64_variants.ORIGINAL);
    },
    decrypt(cipher) {
      const fail = (): never => {
        throw new S1PilotError('VAULT_DECRYPT', 'Failed to decrypt secret (wrong master key or corrupted data)');
      };
      if (!cipher.startsWith(PREFIX)) return fail();
      let blob: Uint8Array;
      try {
        blob = sodium.from_base64(cipher.slice(PREFIX.length), sodium.base64_variants.ORIGINAL);
      } catch {
        return fail();
      }
      const nonceLength = sodium.crypto_secretbox_NONCEBYTES;
      if (blob.length < nonceLength + sodium.crypto_secretbox_MACBYTES) return fail();
      try {
        const plain = sodium.crypto_secretbox_open_easy(blob.slice(nonceLength), blob.slice(0, nonceLength), key);
        return sodium.to_string(plain);
      } catch {
        return fail();
      }
    },
  };
}

/** Re-encrypts ciphertexts from `oldKey` to `newKey` (both base64). Throws `VAULT_DECRYPT` on a wrong old key. */
export async function rotateKey(oldKey: string, newKey: string, ciphertexts: string[]): Promise<string[]> {
  const oldVault = await createVault({ masterKey: oldKey });
  const newVault = await createVault({ masterKey: newKey });
  return ciphertexts.map((c) => newVault.encrypt(oldVault.decrypt(c)));
}

/**
 * Re-encrypts every secret variable in the database from `oldVault` to `newVault`, atomically.
 * Returns the number of rows rotated. Nothing changes if any row fails to decrypt.
 */
export function rotateDbSecrets(db: Db, oldVault: Vault, newVault: Vault): number {
  return atomic(db, () => {
    const rows = db.orm.select().from(variables).where(isNotNull(variables.secretCiphertext)).all();
    for (const row of rows) {
      const plain = oldVault.decrypt(row.secretCiphertext as string);
      db.orm.update(variables).set({ secretCiphertext: newVault.encrypt(plain) }).where(eq(variables.id, row.id)).run();
    }
    return rows.length;
  });
}
