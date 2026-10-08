import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S1PilotError } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { findProjectRoot, loadCaseFile, loadProjectDir } from './load.js';

const CASE = `
key: SHOP-TC-42
title: Guest can check out
steps:
  - action: Open the shop
    expected: The shop is shown
    assert:
      - type: urlMatches
        pattern: /shop
`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 's1p-sync-'));
}

describe('loadCaseFile', () => {
  it('loads a YAML case into a TestCase with defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'tc.yaml'), CASE);
    const tc = loadCaseFile(join(dir, 'tc.yaml'));
    expect(tc).toMatchObject({ key: 'SHOP-TC-42', priority: 'P2', type: 'e2e', status: 'draft', version: 1 });
    expect(tc.id).toBeTruthy();
    expect(tc.steps[0]?.assert[0]).toEqual({ type: 'urlMatches', pattern: '/shop' });
  });

  it('reports the file and every issue for an invalid case', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'bad.yaml'), 'key: X\ntitle: ""\nsteps: []\n');
    try {
      loadCaseFile(join(dir, 'bad.yaml'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(S1PilotError);
      expect((error as S1PilotError).code).toBe('CASE_FILE_INVALID');
      expect((error as S1PilotError).message).toContain('bad.yaml');
      expect((error as S1PilotError).message).toContain('steps');
    }
  });

  it('rejects malformed YAML and missing files', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x.yaml'), 'key: [unclosed');
    expect(() => loadCaseFile(join(dir, 'x.yaml'))).toThrow(/not valid YAML/);
    expect(() => loadCaseFile(join(dir, 'missing.yaml'))).toThrow(/Cannot read/);
  });
});

describe('loadProjectDir', () => {
  function project(extra = ''): string {
    const root = tmp();
    mkdirSync(join(root, '.s1pilot', 'suites', 'checkout'), { recursive: true });
    writeFileSync(
      join(root, '.s1pilot', 'project.yaml'),
      `key: SHOP
name: Shop
defaultEnvironment: staging
environments:
  - name: staging
    baseUrl: https://staging.example.com
    variables:
      - { key: email, value: a@b.c }
      - { key: password, secret: true, value: "env:SHOP_PASSWORD" }
  - name: production
    baseUrl: https://shop.example.com
model:
  system1: { adapter: systemone, baseUrl: "http://localhost:8000", model: clef-flash, apiKeyRef: "env:S1_KEY", profileId: clef-flash }
${extra}`,
    );
    writeFileSync(join(root, '.s1pilot', 'suites', 'checkout', 'tc-042.yaml'), CASE);
    return root;
  }

  it('reads project, environments, model and suites', () => {
    const root = project();
    const loaded = loadProjectDir(root);
    expect(loaded.project).toMatchObject({ key: 'SHOP', name: 'Shop' });
    expect(loaded.project.defaultEnvironmentId).toBe(loaded.environments[0]?.id);
    expect(loaded.model?.system1.apiKeyRef).toBe('env:S1_KEY');
    expect(loaded.cases.map((c) => c.key)).toEqual(['SHOP-TC-42']);
    expect(loaded.cases[0]?.projectId).toBe(loaded.project.id);
  });

  it('turns env: values into env-sourced secret variables and never reads them', () => {
    const [staging] = loadProjectDir(project()).environments;
    expect(staging?.variables).toEqual([
      { key: 'email', value: 'a@b.c', secret: false, source: 'inline' },
      { key: 'password', secret: true, source: 'env', envVar: 'SHOP_PASSWORD' },
    ]);
  });

  it('makes production environments read-only by default', () => {
    const envs = loadProjectDir(project()).environments;
    expect(envs.find((e) => e.name === 'production')?.readOnly).toBe(true);
    expect(envs.find((e) => e.name === 'staging')?.readOnly).toBe(false);
  });

  it('finds the project root upwards from a case file', () => {
    const root = project();
    expect(findProjectRoot(join(root, '.s1pilot', 'suites', 'checkout', 'tc-042.yaml'))).toBe(root);
    expect(findProjectRoot(tmp())).toBeUndefined();
  });

  it('rejects an unknown default environment', () => {
    const root = tmp();
    mkdirSync(join(root, '.s1pilot'), { recursive: true });
    writeFileSync(join(root, '.s1pilot', 'project.yaml'), 'key: SHOP\nname: Shop\ndefaultEnvironment: nope\n');
    expect(() => loadProjectDir(root)).toThrow(/defaultEnvironment/);
  });
});
