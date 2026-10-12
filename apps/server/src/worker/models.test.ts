import type { ModelSettings } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { modelKeys, system2KeySource } from './models.js';

const thresholds = { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 };
const openrouter = (s2: Partial<NonNullable<ModelSettings['system2']>> = {}): ModelSettings => ({
  system1: { adapter: 'systemone', baseUrl: 'https://openrouter.ai/api/alpha/decisions', model: 'cloudflare/clef', apiKeyRef: 'env:OR_KEY' },
  system2: { adapter: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-4.5', ...s2 },
  thresholds,
  dualOrderSensitive: true,
});

describe('modelKeys', () => {
  it('gives System 2 the System 1 key on the same host when it has none of its own', () => {
    expect(modelKeys(openrouter(), { OR_KEY: 'k1' })).toEqual({ s1: 'k1', s2: 'k1' });
  });

  it('prefers System 2 own reference, then S1PILOT_S2_API_KEY', () => {
    expect(modelKeys(openrouter({ apiKeyRef: 'env:S2_KEY' }), { OR_KEY: 'k1', S2_KEY: 'k2' })).toEqual({ s1: 'k1', s2: 'k2' });
    expect(modelKeys(openrouter(), { OR_KEY: 'k1', S1PILOT_S2_API_KEY: 'k3' })).toEqual({ s1: 'k1', s2: 'k3' });
  });

  it('never sends the System 1 key to another host', () => {
    expect(modelKeys(openrouter({ baseUrl: 'http://localhost:11434/v1' }), { OR_KEY: 'k1' })).toEqual({ s1: 'k1' });
  });

  it('reports a referenced variable that is not set', () => {
    expect(() => modelKeys(openrouter({ apiKeyRef: 'env:MISSING' }), { OR_KEY: 'k1' })).toThrow(/MISSING/);
  });
});

describe('system2KeySource', () => {
  it('names the variable or explains the fallbacks, never a key', () => {
    expect(system2KeySource(openrouter({ apiKeyRef: 'env:S2_KEY' }))).toMatch(/environment variable S2_KEY/);
    const fallback = system2KeySource(openrouter());
    expect(fallback).toMatch(/S1PILOT_S2_API_KEY or, when that is unset, the System 1 key/);
    expect(fallback).toMatch(/pasted key is only used for Test connection/);
    expect(system2KeySource(openrouter({ baseUrl: 'http://localhost:11434/v1' }))).not.toMatch(/System 1 key/);
  });
});
