import { describe, expect, it } from 'vitest';

import { repos } from './repos/index.js';
import { seedDemo } from './seed.js';
import { memoryDb } from './test-utils.js';

describe('seedDemo', () => {
  it('creates SHOP with three environments and the guest-checkout case, idempotently', async () => {
    const db = memoryDb();
    const project = await seedDemo(db);
    expect(project.key).toBe('SHOP');

    const envs = await repos.environments.listByProject(db, project.id);
    expect(envs.map((e) => e.name).sort()).toEqual(['dev', 'prod', 'staging']);
    expect(envs.find((e) => e.name === 'prod')?.readOnly).toBe(true);
    expect(project.defaultEnvironmentId).toBe(envs.find((e) => e.name === 'dev')?.id);

    const [testCase] = await repos.cases.list(db, { projectId: project.id });
    expect(testCase).toMatchObject({ key: 'SHOP-TC-1', priority: 'P1', requirements: ['SHOP-REQ-7'] });
    expect(testCase?.steps).toHaveLength(4);

    expect((await seedDemo(db)).id).toBe(project.id);
    expect(await repos.cases.list(db, { projectId: project.id })).toHaveLength(1);
  });
});
