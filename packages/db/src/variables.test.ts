import { createRedactor, newId, type Environment } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { openDb } from './db.js';
import { repos } from './repos/index.js';
import { makeProject } from './test-utils.js';
import { resolveVariables } from './variables.js';
import { createVault, generateMasterKey } from './vault.js';

const vault = await createVault({ masterKey: await generateMasterKey() });

function env(variables: Environment['variables']): Pick<Environment, 'name' | 'variables'> {
  return { name: 'staging', variables };
}

describe('resolveVariables', () => {
  it('resolves inline, env-sourced and secret variables', () => {
    const resolved = resolveVariables(
      env([
        { key: 'REGION', value: 'eu', secret: false, source: 'inline' },
        { key: 'API_TOKEN', secret: true, source: 'env', envVar: 'SHOP_TOKEN' },
        { key: 'PASSWORD', secret: true, source: 'inline' },
      ]),
      { vault, processEnv: { SHOP_TOKEN: 'tok-123' }, ciphertexts: { PASSWORD: vault.encrypt('hunter2') } },
    );
    expect(resolved.keys()).toEqual(['REGION', 'API_TOKEN', 'PASSWORD']);
    expect(resolved.get('REGION')).toBe('eu');
    expect(resolved.get('API_TOKEN')).toBe('tok-123');
    expect(resolved.get('PASSWORD')).toBe('hunter2');
    expect(resolved.get('NOPE')).toBeUndefined();
    expect([resolved.isSecret('REGION'), resolved.isSecret('PASSWORD'), resolved.isSecret('NOPE')]).toEqual([false, true, false]);
    expect(resolved.secretValues().sort()).toEqual(['hunter2', 'tok-123']);
  });

  it('publicView replaces secrets with «secret:key»', () => {
    const resolved = resolveVariables(
      env([
        { key: 'REGION', value: 'eu', secret: false, source: 'inline' },
        { key: 'PASSWORD', secret: true, source: 'inline' },
      ]),
      { vault, ciphertexts: { PASSWORD: vault.encrypt('hunter2') } },
    );
    expect(resolved.publicView()).toEqual({ REGION: 'eu', PASSWORD: '«secret:PASSWORD»' });
    expect(JSON.stringify(resolved.publicView())).not.toContain('hunter2');
  });

  it('names the key and env var, never a value, when an env var is missing', () => {
    const call = () =>
      resolveVariables(env([{ key: 'API_TOKEN', secret: true, source: 'env', envVar: 'SHOP_TOKEN' }]), {
        vault,
        processEnv: { OTHER: 'leaky-value' },
      });
    expect(call).toThrowError(expect.objectContaining({ code: 'MISSING_ENV_VAR' }));
    expect(call).toThrow(/SHOP_TOKEN.*API_TOKEN.*staging/);
    expect(call).not.toThrow(/leaky-value/);
  });

  it('errors clearly for secrets without a stored value and valueless inline variables', () => {
    expect(() => resolveVariables(env([{ key: 'PW', secret: true, source: 'inline' }]), { vault })).toThrow(/"PW"/);
    expect(() => resolveVariables(env([{ key: 'X', secret: false, source: 'inline' }]), { vault })).toThrowError(
      expect.objectContaining({ code: 'MISSING_VALUE' }),
    );
  });

  it('end to end: database → vault → resolved vars → redactor', async () => {
    const db = openDb({ url: ':memory:', crypto: vault });
    const project = await makeProject(db);
    const created = await repos.environments.create(db, {
      id: newId(), projectId: project.id, name: 'staging', baseUrl: 'https://staging.example.com',
      variables: [{ key: 'PASSWORD', value: 'p@ss word', secret: true }, { key: 'REGION', value: 'eu' }],
    });
    const loaded = (await repos.environments.get(db, created.id)) as Environment;
    const resolved = resolveVariables(loaded, { vault, ciphertexts: await repos.environments.secretCiphertexts(db, created.id) });
    expect(resolved.get('PASSWORD')).toBe('p@ss word');

    const redactor = createRedactor({ secrets: resolved.secretValues(), patterns: [] });
    expect(redactor.redact('POST /login?pw=p%40ss%20word body=p@ss word')).toBe('POST /login?pw=[REDACTED] body=[REDACTED]');
  });
});
