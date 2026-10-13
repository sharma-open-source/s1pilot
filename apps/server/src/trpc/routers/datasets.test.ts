import { createVault, openDb, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
afterEach(() => dbs.splice(0).forEach((d) => d.close()));

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const api = makeCaller(createContext({ db, config: loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot' }, {}), log: createLogger({ level: 'silent' }) }));
  await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  return { api, db };
}

describe('datasets router', () => {
  it('uploads CSV and JSON, replaces by name and counts cases that use a set', async () => {
    const { api } = await setup();
    expect(await api.datasets.list({ projectKey: 'SHOP' })).toEqual([]);
    expect(await api.datasets.upload({ projectKey: 'SHOP', fileName: 'addresses.csv', content: 'zip,city\n10115,Berlin\n75001,Paris\n' })).toMatchObject({ name: 'addresses', rows: 2 });
    await api.datasets.upload({ projectKey: 'SHOP', fileName: 'cards.json', content: JSON.stringify([{ number: '4242', ok: true }]) });
    await api.datasets.upload({ projectKey: 'SHOP', fileName: 'addresses.json', content: JSON.stringify([{ zip: '1' }]) });
    await api.cases.create({ projectKey: 'SHOP', title: 'Ship', steps: [{ action: 'Open' }], parameters: [{ dataset: 'addresses.csv' }] });

    const list = await api.datasets.list({ projectKey: 'SHOP' });
    expect(list).toEqual([
      expect.objectContaining({ name: 'addresses', rows: 1, usedBy: 1, environment: null }),
      expect.objectContaining({ name: 'cards', rows: 1, usedBy: 0 }),
    ]);
  });

  it('rejects unsupported or malformed files', async () => {
    const { api } = await setup();
    await expect(api.datasets.upload({ projectKey: 'SHOP', fileName: 'a.txt', content: 'x' })).rejects.toThrow(/\.csv or \.json/);
    await expect(api.datasets.upload({ projectKey: 'SHOP', fileName: 'a.json', content: '{"a":1}' })).rejects.toThrow(/array of flat objects/);
    await expect(api.datasets.upload({ projectKey: 'SHOP', fileName: 'a.csv', content: 'only,header\n' })).rejects.toThrow(/no data rows/);
  });
});
