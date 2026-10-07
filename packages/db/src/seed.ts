import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { newId, type Project } from '@s1pilot/domain';

import { openDb, type Db } from './db.js';
import { repos } from './repos/index.js';

/**
 * Creates the demo `SHOP` project: dev/staging/prod environments (prod read-only) and the
 * plan §1.2 guest-checkout case. Idempotent: returns the existing project when present.
 */
export async function seedDemo(db: Db): Promise<Project> {
  const existing = await repos.projects.getByKey(db, 'SHOP');
  if (existing) return existing;

  const projectId = newId();
  const envs = [
    { name: 'dev', baseUrl: 'http://localhost:3000', readOnly: false },
    { name: 'staging', baseUrl: 'https://staging.shop.example.com', readOnly: false },
    { name: 'prod', baseUrl: 'https://shop.example.com', readOnly: true },
  ].map((env) => ({ ...env, id: newId(), projectId }));

  await repos.projects.create(db, {
    id: projectId,
    name: 'Shop',
    key: 'SHOP',
    modelSettings: {
      system1: { adapter: 'mock', model: 'mock' },
      thresholds: { act: 0.9, pass: 0.8, fail: 0.2, escalate: 0.5 },
      dualOrderSensitive: false,
    },
  });
  for (const env of envs) await repos.environments.create(db, env);
  const dev = envs[0];
  if (dev) await repos.projects.update(db, projectId, { defaultEnvironmentId: dev.id });

  const suite = await repos.suites.create(db, { id: newId(), projectId, name: 'Checkout' });
  await repos.cases.create(db, projectId, {
    suiteId: suite.id,
    title: 'Guest can check out a single item',
    priority: 'P1',
    type: 'e2e',
    status: 'ready',
    tags: ['checkout', 'guest', 'smoke'],
    requirements: ['SHOP-REQ-7'],
    preconditions: [{ flow: 'clear-cart' }],
    parameters: [
      { size: 'M', colour: 'blue' },
      { size: 'L', colour: 'black' },
    ],
    steps: [
      {
        action: 'Search for "t-shirt" and open the "Classic Tee" product',
        expected: 'The product page for Classic Tee is shown',
      },
      {
        action: 'Choose colour {colour} and size {size}, then add to cart',
        expected: 'Cart badge shows 1 item',
        assert: [{ type: 'elementText', role: 'status', contains: '1' }],
      },
      {
        action: 'Go to checkout as guest and fill the shipping form',
        inputs: ['shipping_name', 'shipping_zip'],
        expected: 'The payment step is displayed',
        assert: [{ type: 'urlMatches', pattern: '/checkout/payment' }],
      },
      { action: 'Stop before payment', expected: 'No order has been placed' },
    ],
  });

  return (await repos.projects.get(db, projectId)) as Project;
}

// Run as a script: `pnpm --filter @s1pilot/db seed:demo`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env['INIT_CWD'] ?? process.cwd();
  const url = process.env['S1PILOT_DB_URL'] ?? `file:${join(root, '.s1pilot', 'data.db')}`;
  const db = openDb({ url });
  const project = await seedDemo(db);
  db.close();
  process.stdout.write(`Seeded demo project ${project.key} in ${url}\n`);
}
