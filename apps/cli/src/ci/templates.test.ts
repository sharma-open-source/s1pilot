import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLinter } from 'actionlint';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ciDir = fileURLToPath(new URL('../../../../docs/ci/', import.meta.url));
const read = (rel: string): string => readFileSync(`${ciDir}${rel}`, 'utf8');

describe('CI templates', () => {
  it('the example GitHub Actions workflow passes actionlint', async () => {
    const lint = await createLinter();
    const results = lint(read('github-actions.example.yml'), '.github/workflows/s1pilot.yml');
    expect(results).toEqual([]);
  });

  it('actionlint really flags a broken workflow (guards against a no-op linter)', async () => {
    const lint = await createLinter();
    const results = lint('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ nope.x }}\n', 'w.yml');
    expect(results.length).toBeGreaterThan(0);
  });

  it('the composite action declares its inputs and never echoes the token', () => {
    const action = parse(read('run-action/action.yml')) as {
      inputs: Record<string, { required?: boolean }>;
      runs: { using: string; steps: Array<{ run?: string; env?: Record<string, string> }> };
    };
    expect(action.runs.using).toBe('composite');
    for (const name of ['plan', 'env', 'server', 'token']) expect(action.inputs[name]?.required).toBe(true);
    const text = read('run-action/action.yml');
    expect(text).not.toMatch(/--token/);
    expect(text).toContain('S1PILOT_TOKEN: ${{ inputs.token }}');
    // Inputs reach shell steps through env vars, never interpolated into the script text.
    for (const step of action.runs.steps) expect(step.run ?? '').not.toContain('${{ inputs.');
  });

  it('the GitLab template uploads the JUnit report', () => {
    const doc = parse(read('.gitlab/s1pilot.yml')) as Record<string, { artifacts: { reports: { junit: string } }; script: string[] }>;
    const job = doc['.s1pilot-run'];
    expect(job?.artifacts.reports.junit).toBe('s1pilot-results/junit.xml');
    expect(job?.script.join(' ')).toContain('--server "$S1PILOT_SERVER"');
  });
});
