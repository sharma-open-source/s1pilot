import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createVault, openDb, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
const fixture = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../packages/sync/src/import/fixtures/${n}`, import.meta.url)), 'utf8');

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const ctx = createContext({
    db,
    config: loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot' }, {}),
    log: createLogger({ level: 'silent' }),
  });
  const api = makeCaller(ctx);
  await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  return api;
}
afterEach(() => dbs.splice(0).forEach((d) => d.close()));

describe('imports router', () => {
  it('previews, imports and re-imports a CSV idempotently', async () => {
    const api = await setup();
    const file = { projectKey: 'SHOP', filename: 'cases.csv', content: fixture('cases.csv') };
    const prev = await api.imports.preview(file);
    expect(prev).toMatchObject({ format: 'csv', total: 3, willCreate: 3, willUpdate: 0 });
    expect(prev.mapping).toMatchObject({ title: 'Title', id: 'ID', suite: 'Suite' });
    expect(prev.sample).toHaveLength(3);

    const first = await api.imports.run(file);
    expect(first).toMatchObject({ format: 'csv', created: 3, updated: 0, skipped: 0, errors: [] });
    const again = await api.imports.run(file);
    expect(again).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    const list = await api.cases.list({ projectKey: 'SHOP' });
    expect(list.total).toBe(3);
    expect(list.items.every((c) => c.status === 'draft')).toBe(true);
    expect((await api.imports.preview(file)).willUpdate).toBe(3);
  });

  it('imports a gherkin outline with parameters into a target suite', async () => {
    const api = await setup();
    const suite = await api.suites.create({ projectKey: 'SHOP', name: 'Imported' });
    const res = await api.imports.run({ projectKey: 'SHOP', filename: 'login.feature', content: fixture('login.feature'), suiteId: suite.id });
    expect(res).toMatchObject({ format: 'gherkin', created: 2 });
    const outline = (await api.cases.list({ projectKey: 'SHOP' })).items.find((c) => c.title === 'Invalid login');
    expect(outline?.parameters).toHaveLength(2);
    expect(outline?.suitePath.map((s) => s.name)).toEqual(['Imported', 'Login']);
  });

  it('rejects unrecognised or broken files', async () => {
    const api = await setup();
    await expect(api.imports.run({ projectKey: 'SHOP', filename: 'x.txt', content: 'hello' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.imports.run({ projectKey: 'SHOP', filename: 'x.json', content: '{nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
