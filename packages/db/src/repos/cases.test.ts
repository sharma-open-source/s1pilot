import { describe, expect, it } from 'vitest';

import { caseInput, makeProject, memoryDb } from '../test-utils.js';

import { repos } from './index.js';

const { cases } = repos;

describe('cases repo', () => {
  it('auto-increments keys per project', async () => {
    const db = memoryDb();
    const shop = await makeProject(db, 'SHOP');
    const web = await makeProject(db, 'WEB');
    const a = await cases.create(db, shop.id, caseInput('a'));
    const b = await cases.create(db, shop.id, caseInput('b'));
    const c = await cases.create(db, web.id, caseInput('c'));
    expect([a.key, b.key, c.key]).toEqual(['SHOP-TC-1', 'SHOP-TC-2', 'WEB-TC-1']);
    expect(await cases.nextCaseNumber(db, shop.id)).toBe(3);
  });

  it('allocates unique keys under concurrent inserts', async () => {
    const db = memoryDb();
    const shop = await makeProject(db);
    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) => cases.create(db, shop.id, caseInput(`c${i}`))),
    );
    expect(new Set(created.map((c) => c.key)).size).toBe(25);
    expect(await cases.nextCaseNumber(db, shop.id)).toBe(26);
  });

  it('applies defaults and finds cases by key', async () => {
    const db = memoryDb();
    const shop = await makeProject(db);
    const created = await cases.create(db, shop.id, caseInput());
    expect(created).toMatchObject({ version: 1, tags: [], parameters: [], preconditions: [] });
    expect((await cases.getByKey(db, 'SHOP-TC-1'))?.id).toBe(created.id);
    expect(await cases.getByKey(db, 'SHOP-TC-99')).toBeUndefined();
  });

  it('bumps version on update and keeps history newest first', async () => {
    const db = memoryDb();
    const shop = await makeProject(db);
    const v1 = await cases.create(db, shop.id, caseInput('first'));
    const v2 = await cases.update(db, v1.id, { title: 'second' });
    const v3 = await cases.update(db, v1.id, { title: 'third', tags: ['x'] });
    expect([v2.version, v3.version]).toEqual([2, 3]);
    expect(v3.key).toBe(v1.key);

    const history = await cases.history(db, v1.id);
    expect(history.map((h) => [h.version, h.title])).toEqual([
      [3, 'third'],
      [2, 'second'],
      [1, 'first'],
    ]);
    expect(history[2]?.tags).toEqual([]);
  });

  it('rejects updates to unknown cases and invalid patches', async () => {
    const db = memoryDb();
    const shop = await makeProject(db);
    await expect(cases.update(db, 'nope', { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const created = await cases.create(db, shop.id, caseInput());
    await expect(cases.update(db, created.id, { steps: [] })).rejects.toThrow();
    expect((await cases.get(db, created.id))?.version).toBe(1);
  });

  it('rejects creating a case in an unknown project, without consuming a number', async () => {
    const db = memoryDb();
    await expect(cases.create(db, 'nope', caseInput())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists with filters', async () => {
    const db = memoryDb();
    const shop = await makeProject(db);
    await cases.create(db, shop.id, { ...caseInput('Login works'), priority: 'P0', tags: ['auth', 'smoke'] });
    await cases.create(db, shop.id, { ...caseInput('Checkout works'), tags: ['smoke'], status: 'ready' });
    await cases.create(db, shop.id, { ...caseInput('Profile edit'), type: 'regression' });

    const titles = async (f: Parameters<typeof cases.list>[1]) => (await cases.list(db, f)).map((c) => c.title);
    expect(await titles({ projectId: shop.id })).toEqual(['Login works', 'Checkout works', 'Profile edit']);
    expect(await titles({ projectId: shop.id, tag: 'smoke' })).toEqual(['Login works', 'Checkout works']);
    expect(await titles({ projectId: shop.id, tag: 'auth' })).toEqual(['Login works']);
    expect(await titles({ projectId: shop.id, priority: 'P0' })).toEqual(['Login works']);
    expect(await titles({ projectId: shop.id, status: 'ready' })).toEqual(['Checkout works']);
    expect(await titles({ projectId: shop.id, type: 'regression' })).toEqual(['Profile edit']);
    expect(await titles({ projectId: shop.id, search: 'check' })).toEqual(['Checkout works']);
    expect(await titles({ projectId: shop.id, search: 'TC-3' })).toEqual(['Profile edit']);
    expect(await titles({ projectId: shop.id, limit: 1, offset: 1 })).toEqual(['Checkout works']);
  });
});
