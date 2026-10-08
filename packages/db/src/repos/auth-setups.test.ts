import { describe, expect, it } from 'vitest';

import { openDb } from '../db.js';
import { makeProject } from '../test-utils.js';
import { rotateDbSecrets, createVault } from '../vault.js';

import { repos } from './index.js';

const key = (n: number): string => Buffer.alloc(32, n).toString('base64');

describe('authSetups repo', () => {
  it('upserts by name, stores the state encrypted, rotates it and cascades on environment delete', async () => {
    const vault = await createVault({ masterKey: key(1) });
    const db = openDb({ url: ':memory:', crypto: vault });
    const project = await makeProject(db);
    const environmentId = 'envone00000000000000001';
    await repos.environments.create(db, { id: environmentId, projectId: project.id, name: 'one', baseUrl: 'http://x.test' });

    const created = await repos.authSetups.upsert(db, { environmentId, name: 'login', kind: 'flow', flowId: 'login-flow' });
    expect(created).toMatchObject({ status: 'never', hasState: false, flowId: 'login-flow' });
    expect(await repos.authSetups.getState(db, created.id)).toBeUndefined();

    const state = JSON.stringify({ cookies: [{ name: 'session', value: 'top-secret' }], origins: [] });
    const saved = await repos.authSetups.saveState(db, created.id, state);
    expect(saved).toMatchObject({ status: 'valid', hasState: true });
    expect(saved.lastRefreshedAt).toBeDefined();
    const raw = db.sqlite.prepare('select state_ciphertext as c from auth_setups').get() as { c: string };
    expect(raw.c).not.toContain('top-secret');
    expect(await repos.authSetups.getState(db, created.id)).toBe(state);

    // Upserting again keeps the id and the state.
    const again = await repos.authSetups.upsert(db, { environmentId, name: 'login', kind: 'flow', flowId: 'other' });
    expect(again).toMatchObject({ id: created.id, flowId: 'other', hasState: true });

    await repos.authSetups.setStatus(db, created.id, 'expired');
    expect((await repos.authSetups.getByName(db, environmentId, 'login'))?.status).toBe('expired');

    const next = await createVault({ masterKey: key(2) });
    expect(rotateDbSecrets(db, vault, next)).toBe(1);
    const rotated = db.sqlite.prepare('select state_ciphertext as c from auth_setups').get() as { c: string };
    expect(next.decrypt(rotated.c)).toBe(state);

    await repos.environments.create(db, { id: 'envtwo0000000000000001', projectId: project.id, name: 'two', baseUrl: 'http://x.test' });
    await repos.environments.delete(db, environmentId);
    expect(await repos.authSetups.get(db, created.id)).toBeUndefined();
    db.close();
  });
});
