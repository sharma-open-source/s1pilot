import { newId } from '@s1pilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../db.js';

import { repos } from './index.js';

const dbs: Db[] = [];
afterEach(() => dbs.splice(0).forEach((d) => d.close()));

async function setup() {
  const db = openDb({ url: ':memory:' });
  dbs.push(db);
  const project = await repos.projects.create(db, { id: newId(), key: 'SHOP', name: 'Shop' });
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'dev', baseUrl: 'http://a.test' });
  return { db, project, env };
}

describe('datasets repo', () => {
  it('upserts by name and scope and prefers the environment-specific set on lookup', async () => {
    const { db, project, env } = await setup();
    const shared = await repos.datasets.upsert(db, { id: newId(), projectId: project.id, name: 'addresses.csv', rows: [{ zip: '1' }] });
    expect(shared.name).toBe('addresses');
    const again = await repos.datasets.upsert(db, { id: newId(), projectId: project.id, name: 'addresses.json', rows: [{ zip: '2' }, { zip: '3' }] });
    expect(again.id).toBe(shared.id);
    await repos.datasets.upsert(db, { id: newId(), projectId: project.id, environmentId: env.id, name: 'addresses', rows: [{ zip: 'dev' }] });

    expect(await repos.datasets.listByProject(db, project.id)).toHaveLength(2);
    expect((await repos.datasets.lookup(db, project.id, 'addresses.csv'))?.rows).toEqual([{ zip: '2' }, { zip: '3' }]);
    expect((await repos.datasets.lookup(db, project.id, 'addresses', env.id))?.rows).toEqual([{ zip: 'dev' }]);
    expect(await repos.datasets.lookup(db, project.id, 'missing')).toBeUndefined();
  });
});

describe('datasets.rowsForEnvironment', () => {
  it('returns shared sets overridden by the environment-specific ones', async () => {
    const { db, project, env } = await setup();
    await repos.datasets.upsert(db, { id: newId(), projectId: project.id, environmentId: env.id, name: 'cards', rows: [{ n: 'dev' }] });
    await repos.datasets.upsert(db, { id: newId(), projectId: project.id, name: 'cards', rows: [{ n: 'shared' }] });
    await repos.datasets.upsert(db, { id: newId(), projectId: project.id, name: 'zips', rows: [{ z: '1' }] });
    expect(await repos.datasets.rowsForEnvironment(db, project.id, env.id)).toEqual({ cards: [{ n: 'dev' }], zips: [{ z: '1' }] });
    expect(await repos.datasets.rowsForEnvironment(db, project.id, 'other')).toEqual({ cards: [{ n: 'shared' }], zips: [{ z: '1' }] });
  });
});
