import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { crawlSite, isAllowedHost, normalizeLink } from './crawl.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let browser: Browser;
let fixture: FixtureServer;
let site: Server;
let siteUrl: string;
let external: Server;
let externalPort = 0;
let externalHits = 0;
const hits: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startFixtureServer();
  external = createServer((_req, res) => {
    externalHits++;
    res.setHeader('content-type', 'text/html');
    res.end('<title>external</title><h1>external</h1>');
  });
  await new Promise<void>((r) => external.listen(0, '127.0.0.1', r));
  externalPort = (external.address() as AddressInfo).port;
  // Same machine, different host name than the site below.
  const extUrl = `http://localhost:${externalPort}/`;
  site = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') {
      res.end(`<title>Home</title><h1>Welcome</h1><a href="/contact">Contact</a> <a href="/logout">Log out</a>
        <a href="${extUrl}">Elsewhere</a><a href="/a.pdf">Doc</a>
        <form method="post" action="/submit"><label for="e">Email</label><input id="e" name="email" value="secret@example.com"><button type="submit">Subscribe</button></form>`);
    } else if (req.url === '/contact') {
      res.end('<title>Contact</title><h1>Contact us</h1><a href="/">Home</a><a href="/p3">3</a><a href="/p4">4</a>');
    } else if (req.url === '/p3' || req.url === '/p4') {
      res.end(`<title>${req.url}</title><a href="/">Home</a>`);
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
  site.close();
  external.close();
});

describe('crawl helpers', () => {
  it('matches hosts and normalizes links', () => {
    expect(isAllowedHost('shop.example.com', 'example.com', ['example.com'])).toBe(true);
    expect(isAllowedHost('evil.com', 'example.com', ['example.com'])).toBe(false);
    expect(isAllowedHost('example.com', 'example.com', [])).toBe(true);
    expect(normalizeLink('/a#x', 'http://h/b')).toBe('http://h/a');
    expect(normalizeLink('mailto:a@b.c', 'http://h/')).toBeUndefined();
  });
});

describe('crawlSite', () => {
  it('stays on the allowed host, never submits forms and honours the page budget', async () => {
    hits.length = 0;
    const result = await crawlSite(browser, { startUrl: siteUrl, maxPages: 3 });
    expect(result.pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/contact', '/p3']);
    expect(hits.every((h) => h.startsWith('GET '))).toBe(true);
    expect(hits.some((h) => h.includes('/logout') || h.includes('/submit'))).toBe(false);
    expect(externalHits).toBe(0);
    expect(result.pages[0]?.forms).toEqual([{ fields: ['Email'], submit: 'Subscribe' }]);
    expect(JSON.stringify(result)).not.toContain('secret@example.com');
    expect(result.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(['state-changing link', 'outside allowed domains', 'not a page']));
  });

  it('visits another domain only when it is allowed', async () => {
    const result = await crawlSite(browser, { startUrl: siteUrl, maxPages: 10, allowDomains: ['localhost'] });
    expect(result.pages.some((p) => p.url.includes(`localhost:${externalPort}`))).toBe(true);
  });

  it('summarises a fixture shop', async () => {
    const result = await crawlSite(browser, { startUrl: `${fixture.url}/shop`, maxPages: 5 });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.every((p) => p.url.startsWith(fixture.url))).toBe(true);
  });
});
