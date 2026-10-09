import { readFileSync } from 'node:fs';

import { TestCaseFileSchema } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { normalise } from './test-utils.js';

import { BUG_IDS, VARIANT_IDS, startFixtureServer } from './index.js';

const PAGES = [
  '/shop',
  '/shop/search?q=tee',
  '/shop/product/classic-tee',
  '/shop/product/coffee-mug',
  '/shop/cart',
  '/shop/checkout',
  '/shop/checkout/shipping',
  '/shop/checkout/payment',
  '/shop/login',
  '/settings',
  '/forms',
  '/mail',
  '/mail/message/2',
];

async function pages(options: Parameters<typeof startFixtureServer>[0]): Promise<Record<string, string>> {
  const server = await startFixtureServer(options);
  try {
    const entries = await Promise.all(
      PAGES.map(async (path) => [path, normalise(await (await fetch(server.url + path)).text())] as const),
    );
    return Object.fromEntries(entries);
  } finally {
    await server.close();
  }
}

describe('server lifecycle', () => {
  it('starts and stops in under 200 ms', async () => {
    const t0 = performance.now();
    const server = await startFixtureServer();
    const started = performance.now() - t0;
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    const t1 = performance.now();
    await server.close();
    expect(started).toBeLessThan(200);
    expect(performance.now() - t1).toBeLessThan(200);
  });

  it('runs many servers in parallel on random ports with independent state', async () => {
    const servers = await Promise.all(Array.from({ length: 5 }, () => startFixtureServer()));
    expect(new Set(servers.map((s) => s.url)).size).toBe(5);
    const [a, b] = servers;
    await fetch(`${a?.url}/settings/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Changed', email: 'x@example.com' }),
    });
    expect(await (await fetch(`${a?.url}/settings`)).text()).toContain('value="Changed"');
    expect(await (await fetch(`${b?.url}/settings`)).text()).toContain('value="Alex Doe"');
    await Promise.all(servers.map((s) => s.close()));
  });

  it('rejects unknown bug and variant ids', async () => {
    await expect(startFixtureServer({ bugs: ['shop.nope'] })).rejects.toThrow(/Unknown fixture flag/);
    await expect(startFixtureServer({ variant: 'nope' })).rejects.toThrow(/Unknown fixture flag/);
  });
});

describe('flag switching', () => {
  const flagsIn = (html: string): { bugs: string[]; variants: string[] } => {
    const match = /window\.__FX__ = (.*?);<\/script>/.exec(html);
    return JSON.parse(match?.[1] ?? '{}') as { bugs: string[]; variants: string[] };
  };

  it('shop.flaky-badge applies the badge bug to every second browser session', async () => {
    const server = await startFixtureServer({ bugs: ['shop.flaky-badge'] });
    try {
      const badge = async (cookie?: string): Promise<{ bad: boolean; cookie: string }> => {
        const res = await fetch(`${server.url}/shop`, { headers: cookie ? { cookie } : {} });
        const set = (res.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
        return { bad: flagsIn(await res.text()).bugs.includes('shop.badge-wrong-count'), cookie: cookie ?? set };
      };
      const s1 = await badge();
      const s2 = await badge();
      const s3 = await badge();
      expect([s1.bad, s2.bad, s3.bad]).toEqual([true, false, true]);
      // A session keeps its behaviour, and unrelated requests do not start sessions.
      expect((await badge(s1.cookie)).bad).toBe(true);
      expect((await badge(s2.cookie)).bad).toBe(false);
      await fetch(`${server.url}/favicon.ico`);
      expect((await badge()).bad).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('honours options, ?bugs= (remembered in a cookie) and headers', async () => {
    const server = await startFixtureServer({ bugs: ['forms.error-not-shown'] });
    try {
      const first = await fetch(`${server.url}/shop?bugs=shop.badge-wrong-count&variant=shop.promo-in-accordion`);
      expect(flagsIn(await first.text())).toEqual({
        bugs: ['forms.error-not-shown', 'shop.badge-wrong-count'],
        variants: ['shop.promo-in-accordion'],
      });
      const cookie = (first.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
      const second = await fetch(`${server.url}/forms`, { headers: { cookie } });
      expect(flagsIn(await second.text()).bugs).toContain('shop.badge-wrong-count');

      const viaHeader = await fetch(`${server.url}/forms`, { headers: { 'x-fixture-bugs': 'shop.zip-validation-missing' } });
      expect(flagsIn(await viaHeader.text()).bugs).toEqual(['forms.error-not-shown', 'shop.zip-validation-missing']);

      const ignored = await fetch(`${server.url}/forms?bugs=made.up`);
      expect(flagsIn(await ignored.text()).bugs).toEqual(['forms.error-not-shown']);
    } finally {
      await server.close();
    }
  });
});

describe('seeded bugs and variants change only what is documented', () => {
  it('bugs never change the markup of any page (behaviour only)', async () => {
    const base = await pages({});
    for (const bug of BUG_IDS) expect(await pages({ bugs: [bug] }), bug).toEqual(base);
  });

  it('each variant changes only its documented page and element', async () => {
    const base = await pages({});
    const changed: Record<string, string[]> = {
      'shop.guest-button-renamed': ['/shop/checkout'],
      'shop.size-picker-dropdown': ['/shop/product/classic-tee'],
      'shop.promo-in-accordion': ['/shop/cart'],
    };
    expect(Object.keys(changed).sort()).toEqual([...VARIANT_IDS].sort());
    for (const variant of VARIANT_IDS) {
      const withVariant = await pages({ variant });
      const diffPages = PAGES.filter((p) => withVariant[p] !== base[p]);
      expect(diffPages, variant).toEqual(changed[variant]);
    }
  });

  it('the guest-button variant changes exactly one line', async () => {
    const [a, b] = [await pages({}), await pages({ variant: 'shop.guest-button-renamed' })];
    const [x, y] = [(a['/shop/checkout'] ?? '').split('\n'), (b['/shop/checkout'] ?? '').split('\n')];
    expect(x).toHaveLength(y.length);
    expect(x.filter((line, i) => line !== y[i])).toHaveLength(1);
  });
});

describe('ground truth', () => {
  interface Truth {
    sites: Record<string, { cases: unknown[]; expectations: { case: string; bugs: string[]; variants: string[]; verdict: string; expectHealing?: boolean }[] }>;
  }
  const truth = JSON.parse(readFileSync(new URL('../ground-truth.json', import.meta.url), 'utf8')) as Truth;

  it('contains valid plan-§1.2 cases with unique keys', () => {
    const keys = Object.values(truth.sites).flatMap((site) => site.cases.map((c) => TestCaseFileSchema.parse(c).key));
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('references existing cases and known flags; every bug and variant is covered', () => {
    const keys = new Set(Object.values(truth.sites).flatMap((site) => site.cases.map((c) => TestCaseFileSchema.parse(c).key)));
    const expectations = Object.values(truth.sites).flatMap((site) => site.expectations);
    for (const e of expectations) {
      expect(keys.has(e.case), e.case).toBe(true);
      for (const bug of e.bugs) expect(BUG_IDS as readonly string[]).toContain(bug);
      for (const variant of e.variants) expect(VARIANT_IDS as readonly string[]).toContain(variant);
    }
    for (const bug of BUG_IDS) {
      expect(expectations.some((e) => e.bugs.includes(bug) && e.verdict === 'failed'), bug).toBe(true);
    }
    for (const variant of VARIANT_IDS) {
      expect(expectations.some((e) => e.variants.includes(variant) && e.verdict === 'passed' && e.expectHealing), variant).toBe(true);
    }
  });
});
