import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId } from '@s1pilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb } from './db.js';
import { repos } from './repos/index.js';
import { makeProject } from './test-utils.js';
import { createVault, generateMasterKey, rotateDbSecrets, rotateKey } from './vault.js';

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 's1pilot-vault-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('vault', () => {
  it('round-trips, including unicode and empty strings, with fresh nonces', async () => {
    const vault = await createVault({ masterKey: await generateMasterKey() });
    for (const plain of ['hunter2', '', 'päss wörd 🔑 ' + 'x'.repeat(5000)]) {
      const cipher = vault.encrypt(plain);
      expect(cipher).toMatch(/^v1:/);
      expect(cipher).not.toContain(plain || 'never-empty');
      expect(vault.decrypt(cipher)).toBe(plain);
    }
    expect(vault.encrypt('same')).not.toBe(vault.encrypt('same'));
  });

  it('throws VAULT_DECRYPT for a wrong key, tampering and garbage', async () => {
    const a = await createVault({ masterKey: await generateMasterKey() });
    const b = await createVault({ masterKey: await generateMasterKey() });
    const cipher = a.encrypt('secret');
    const tampered = cipher.slice(0, -4) + (cipher.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    for (const bad of [cipher, tampered, 'not-a-cipher', 'v1:', 'v1:@@@@']) {
      const vault = bad === cipher ? b : a;
      expect(() => vault.decrypt(bad)).toThrowError(expect.objectContaining({ code: 'VAULT_DECRYPT' }));
    }
    expect(() => a.decrypt('v1:' + 'A'.repeat(20))).toThrow(/Failed to decrypt/);
  });

  it('reads the master key from S1P_MASTER_KEY and rejects invalid keys without echoing them', async () => {
    const key = await generateMasterKey();
    const a = await createVault({ env: { S1P_MASTER_KEY: key }, keyFile: join(tmp(), 'unused.key') });
    const b = await createVault({ masterKey: key });
    expect(b.decrypt(a.encrypt('x'))).toBe('x');

    const bad = await createVault({ masterKey: 'c2hvcnQ=' }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'VAULT_KEY_INVALID' });
    expect(String((bad as Error).message)).not.toContain('c2hvcnQ=');
    await expect(createVault({ masterKey: '!!!notbase64***' })).rejects.toMatchObject({ code: 'VAULT_KEY_INVALID' });
  });

  it('generates a 0600 key file on first start and reuses it', async () => {
    const keyFile = join(tmp(), 'nested', 'master.key');
    const first = await createVault({ env: {}, keyFile });
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const second = await createVault({ env: {}, keyFile });
    expect(second.decrypt(first.encrypt('persisted'))).toBe('persisted');
    expect(readFileSync(keyFile, 'utf8').trim()).toHaveLength(44);
  });

  it('rotates ciphertexts to a new key', async () => {
    const [oldKey, newKey] = [await generateMasterKey(), await generateMasterKey()];
    const oldVault = await createVault({ masterKey: oldKey });
    const rotated = await rotateKey(oldKey, newKey, [oldVault.encrypt('one'), oldVault.encrypt('two')]);
    const newVault = await createVault({ masterKey: newKey });
    expect(rotated.map((c) => newVault.decrypt(c))).toEqual(['one', 'two']);
    expect(() => oldVault.decrypt(rotated[0] as string)).toThrow();
    await expect(rotateKey(newKey, oldKey, ['v1:' + 'A'.repeat(60)])).rejects.toMatchObject({ code: 'VAULT_DECRYPT' });
  });

  it('works as the database crypto and rotates stored secrets atomically', async () => {
    const [oldKey, newKey] = [await generateMasterKey(), await generateMasterKey()];
    const oldVault = await createVault({ masterKey: oldKey });
    const newVault = await createVault({ masterKey: newKey });
    const db = openDb({ url: ':memory:', crypto: oldVault });
    const project = await makeProject(db);
    const env = await repos.environments.create(db, {
      id: newId(), projectId: project.id, name: 'dev', baseUrl: 'http://localhost:3000',
      variables: [{ key: 'PW', value: 'hunter2-plain', secret: true }, { key: 'A', value: '1' }],
    });
    const raw = JSON.stringify(db.sqlite.prepare('select * from variables').all());
    expect(raw).not.toContain('hunter2-plain');

    expect(rotateDbSecrets(db, oldVault, newVault)).toBe(1);
    const cipher = (await repos.environments.secretCiphertexts(db, env.id))['PW'] as string;
    expect(newVault.decrypt(cipher)).toBe('hunter2-plain');

    // A failing rotation (wrong old vault) changes nothing.
    expect(() => rotateDbSecrets(db, oldVault, newVault)).toThrow();
    expect((await repos.environments.secretCiphertexts(db, env.id))['PW']).toBe(cipher);
  });
});
