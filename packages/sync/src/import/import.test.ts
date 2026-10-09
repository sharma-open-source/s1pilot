import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { applyImport, detectImportFormat, parseCsvCases, parseCsvRows, parseImport } from './index.js';

const fx = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const crypto = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) };
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('csv', () => {
  it('parses quotes and embedded newlines', () => {
    expect(parseCsvRows('a,b\n"x, ""y""","l1\nl2"\r\n')).toEqual([['a', 'b'], ['x, "y"', 'l1\nl2']]);
  });

  it('imports numbered lines, continuation rows and repeated ids', () => {
    const r = parseCsvCases(fx('cases.csv'));
    expect(r.errors).toEqual([]);
    expect(r.cases.map((c) => [c.externalRef, c.steps.length, c.priority])).toEqual([
      ['csv:T-1', 3, 'P1'],
      ['csv:T-2', 1, 'P3'],
      ['csv:T-3', 3, 'P2'],
    ]);
    expect(r.cases[0]?.suitePath).toEqual(['Auth', 'Login']);
    expect(r.cases[0]?.tags).toEqual(['smoke', 'auth']);
    expect(r.cases[0]?.steps[2]).toEqual({ action: 'Click Sign in', expected: 'Dashboard opens' });
    expect(r.cases[2]?.steps[1]?.expected).toBe('Results are listed');
  });

  it('requires a title column', () => {
    expect(() => parseCsvCases('a,b\n1,2\n')).toThrow(/title/);
  });
});

describe('gherkin', () => {
  it('maps scenarios and outline examples to parameters', () => {
    const r = parseImport('gherkin', fx('login.feature'), { filename: 'login.feature' });
    expect(r.cases).toHaveLength(2);
    const [valid, outline] = r.cases;
    expect(valid?.steps).toEqual([
      { action: 'I am on the login page' },
      { action: 'I sign in as "alice"', expected: 'I see the dashboard; I see a welcome banner' },
    ]);
    expect(valid?.priority).toBe('P1');
    expect(valid?.tags).toEqual(['auth', 'P1'].filter((t) => t !== 'P1'));
    expect(outline?.steps[1]?.action).toBe('I sign in as "{user}" with password "{password}"');
    expect(outline?.parameters).toEqual([
      { user: 'bob', password: 'wrong', error: 'Bad password' },
      { user: 'carol', password: '', error: 'Password needed' },
    ]);
    expect(outline?.tags).toContain('slow');
    expect(outline?.suitePath).toEqual(['Login']);
  });

  it('rejects invalid gherkin', () => {
    expect(() => parseImport('gherkin', 'not gherkin at all')).toThrow(/Gherkin/);
  });
});

describe('testrail / xray / zephyr', () => {
  it('imports TestRail XML with nested sections', () => {
    const r = parseImport('testrail', fx('testrail.xml'));
    expect(r.errors).toEqual([]);
    expect(r.cases.map((c) => [c.externalRef, c.suitePath.join('/'), c.steps.length])).toEqual([
      ['testrail:C101', 'Checkout', 3],
      ['testrail:C102', 'Checkout', 2],
      ['testrail:C103', 'Checkout/Shipping', 1],
    ]);
    expect(r.cases[0]?.title).toBe('Pay by card & confirm');
    expect(r.cases[0]?.priority).toBe('P0');
    expect(r.cases[1]?.steps[1]?.expected).toBe('Total reduced');
  });

  it('imports TestRail CSV', () => {
    const csv = 'ID,Title,Section Hierarchy,Priority,Steps,Expected Result\nC1,Foo,A > B,High,"1. one\n2. two","1. x\n2. y"\n';
    expect(detectImportFormat('r.csv', csv)).toBe('testrail');
    const r = parseImport('testrail', csv);
    expect(r.cases[0]).toMatchObject({ externalRef: 'testrail:C1', suitePath: ['A', 'B'], priority: 'P1' });
    expect(r.cases[0]?.steps).toHaveLength(2);
  });

  it('imports Xray JSON and reports cases without steps', () => {
    const r = parseImport('xray', fx('xray.json'));
    expect(r.cases.map((c) => c.externalRef)).toEqual(['xray:XR-1', 'xray:XR-2']);
    expect(r.cases[0]?.suitePath).toEqual(['Web', 'Cart']);
    expect(r.cases[0]?.steps[1]).toEqual({ action: 'Click Add (data: qty=2)', expected: 'Badge shows 2' });
    expect(r.errors).toEqual([{ index: 3, title: 'No steps here', message: 'Test has no steps' }]);
  });

  it('imports Zephyr CSV with one row per step', () => {
    const r = parseImport('zephyr', fx('zephyr.csv'));
    expect(r.errors).toEqual([]);
    expect(r.cases.map((c) => [c.externalRef, c.steps.length, c.suitePath.join('/')])).toEqual([
      ['zephyr:Z-1', 2, 'Catalog/Filters'],
      ['zephyr:Z-2', 1, 'Catalog'],
    ]);
    expect(r.cases[0]?.steps[1]).toEqual({ action: 'Select category Shoes (data: Shoes)', expected: 'Only shoes listed' });
  });
});

describe('playwright spec', () => {
  it('turns test() blocks into steps, assertions and learned actions', () => {
    const r = parseImport('playwright', fx('shop.spec.ts.txt'), { filename: 'shop.spec.ts' });
    expect(r.errors).toEqual([]);
    expect(r.cases.map((c) => c.title)).toEqual(['add to cart', 'sign in']);
    const [add, signIn] = r.cases;
    expect(add?.suitePath).toEqual(['shop', 'Shop']);
    expect(add?.steps.map((s) => s.action)).toEqual(['Open /shop', 'Click the "Add to cart" button']);
    expect(add?.steps[1]?.assert).toEqual([
      { type: 'elementText', testId: 'badge', contains: '1' },
      { type: 'urlMatches', pattern: 'shop' },
    ]);
    expect(add?.actions?.[1]).toMatchObject({ action: 'click', locators: [{ kind: 'role', value: 'button', name: 'Add to cart' }] });
    // secret-looking field values are never copied
    const texts = JSON.stringify(signIn);
    expect(texts).not.toContain('hunter2');
    expect(signIn?.steps.map((s) => s.action)).toContain('Enter "a@b.co" in the "Email" field');
    expect(signIn?.steps.map((s) => s.action)).toContain('Enter {password} in the "Password" field');
    expect(signIn?.steps.at(-1)?.assert?.[0]).toMatchObject({ type: 'elementVisible', text: 'Welcome', visible: true });
  });
});

describe('detect', () => {
  it('recognises each fixture', () => {
    expect(detectImportFormat('cases.csv', fx('cases.csv'))).toBe('csv');
    expect(detectImportFormat('zephyr.csv', fx('zephyr.csv'))).toBe('zephyr');
    expect(detectImportFormat('login.feature', fx('login.feature'))).toBe('gherkin');
    expect(detectImportFormat('t.xml', fx('testrail.xml'))).toBe('testrail');
    expect(detectImportFormat('x.json', fx('xray.json'))).toBe('xray');
    expect(detectImportFormat('shop.spec.ts', fx('shop.spec.ts.txt'))).toBe('playwright');
    expect(detectImportFormat('notes.txt', 'hello')).toBeUndefined();
  });
});

describe('applyImport', () => {
  async function setup(): Promise<{ db: Db; projectId: string }> {
    const db = openDb({ url: ':memory:', crypto });
    dbs.push(db);
    const p = await repos.projects.create(db, { id: newId(), key: 'SHOP', name: 'Shop' } as never);
    return { db, projectId: p.id };
  }

  it('creates then updates instead of duplicating', async () => {
    const { db, projectId } = await setup();
    const parsed = parseImport('csv', fx('cases.csv'));
    const first = await applyImport(db, projectId, parsed.cases);
    expect(first).toMatchObject({ created: 3, updated: 0, skipped: 0, errors: [] });
    const again = await applyImport(db, projectId, parsed.cases);
    expect(again).toMatchObject({ created: 0, updated: 0, skipped: 3 });
    expect(await repos.cases.list(db, { projectId })).toHaveLength(3);

    const changed = parseCsvCases(fx('cases.csv').replace('Logout', 'Log out of the app'));
    const third = await applyImport(db, projectId, changed.cases);
    expect(third).toMatchObject({ created: 0, updated: 1, skipped: 2 });
    const all = await repos.cases.list(db, { projectId });
    expect(all).toHaveLength(3);
    const edited = all.find((c) => c.externalRef === 'csv:T-2');
    expect(edited).toMatchObject({ title: 'Log out of the app', version: 2, status: 'draft' });
  });

  it('creates nested suites under the target suite', async () => {
    const { db, projectId } = await setup();
    const target = await repos.suites.create(db, { id: newId(), projectId, name: 'Imported', position: 0 });
    await applyImport(db, projectId, parseImport('testrail', fx('testrail.xml')).cases, { targetSuiteId: target.id });
    const suites = await repos.suites.listByProject(db, projectId);
    expect(suites.map((s) => s.name).sort()).toEqual(['Checkout', 'Imported', 'Shipping']);
    const shipping = suites.find((s) => s.name === 'Shipping');
    const checkout = suites.find((s) => s.name === 'Checkout');
    expect(shipping?.parentId).toBe(checkout?.id);
    expect(checkout?.parentId).toBe(target.id);
  });
});
