import { describe, expect, it } from 'vitest';

import { EnvironmentSchema } from './environment.js';
import { ModelEndpointSchema, ModelSettingsSchema } from './model-settings.js';
import { ProjectSchema } from './project.js';

const thresholds = { act: 0.9, pass: 0.8, fail: 0.2, escalate: 0.5 };

describe('project', () => {
  const valid = { id: 'p1', name: 'Shop', key: 'SHOP' };

  it('parses a project and applies defaults', () => {
    const project = ProjectSchema.parse(valid);
    expect(project.retentionDays).toBe(30);
    expect(project.dataPolicy).toEqual({
      sendPageText: true,
      sendScreenshots: 'ambiguous',
      redactPatterns: [],
    });
  });

  it.each(['shop', 'S', '1SHOP', 'TOOLONGKEY1', 'SH-OP'])('rejects key %s readably', (key) => {
    const result = ProjectSchema.safeParse({ ...valid, key });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('Project key must be');
  });
});

describe('model settings', () => {
  it('requires baseUrl except for the mock adapter', () => {
    expect(ModelEndpointSchema.safeParse({ adapter: 'systemone', model: 'clef' }).success).toBe(false);
    expect(ModelEndpointSchema.safeParse({ adapter: 'mock', model: 'mock' }).success).toBe(true);
  });

  it('rejects an unknown adapter and inverted thresholds', () => {
    expect(ModelEndpointSchema.safeParse({ adapter: 'nope', model: 'm' }).success).toBe(false);
    const inverted = ModelSettingsSchema.safeParse({
      system1: { adapter: 'mock', model: 'm' },
      thresholds: { ...thresholds, fail: 0.9, pass: 0.5 },
    });
    expect(inverted.success).toBe(false);
  });

  it('parses valid settings', () => {
    const parsed = ModelSettingsSchema.parse({
      system1: { adapter: 'decide', baseUrl: 'http://localhost:8000', model: 'jev-9b' },
      thresholds,
    });
    expect(parsed.dualOrderSensitive).toBe(false);
  });
});

describe('environment', () => {
  it('parses with defaults', () => {
    const env = EnvironmentSchema.parse({
      id: 'e1',
      projectId: 'p1',
      name: 'staging',
      baseUrl: 'https://staging.example.com',
    });
    expect(env.browsers).toEqual([{ browser: 'chromium' }]);
    expect(env.readOnly).toBe(false);
    expect(env.requireApprovalFor).toEqual(['pay', 'delete', 'send']);
  });

  it('requires envVar for env-sourced variables and a valid URL', () => {
    const base = { id: 'e1', projectId: 'p1', name: 'x', baseUrl: 'https://a.example' };
    expect(
      EnvironmentSchema.safeParse({ ...base, variables: [{ key: 'K', source: 'env' }] }).success,
    ).toBe(false);
    expect(EnvironmentSchema.safeParse({ ...base, baseUrl: 'not a url' }).success).toBe(false);
  });
});
