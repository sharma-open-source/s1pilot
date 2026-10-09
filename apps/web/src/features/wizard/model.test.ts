import { beforeEach, describe, expect, it } from 'vitest';

import {
  actBounds,
  apiKeyRefFrom,
  BasicsSchema,
  clearDraft,
  constrainThresholds,
  EMPTY_DRAFT,
  EnvironmentsSchema,
  escalateBounds,
  keyFromName,
  loadDraft,
  ModelsSchema,
  DEFAULT_MODELS,
  nextStep,
  parseStep,
  prevStep,
  saveDraft,
} from './model';

describe('steps', () => {
  it('parses the step param with a basics fallback', () => {
    expect(parseStep('models')).toBe('models');
    expect(parseStep('first-tests')).toBe('first-tests');
    expect(parseStep('nope')).toBe('basics');
    expect(parseStep(undefined)).toBe('basics');
  });

  it('walks forward and back', () => {
    expect(nextStep('basics')?.label).toBe('Environments');
    expect(nextStep('first-tests')).toBeNull();
    expect(prevStep('login')?.id).toBe('models');
    expect(prevStep('basics')).toBeNull();
  });
});

describe('keyFromName', () => {
  it('uppercases and strips punctuation', () => {
    expect(keyFromName('Shop front!')).toBe('SHOPFRONT');
  });
  it('drops leading digits and caps at 10 characters', () => {
    expect(keyFromName('3rd Party Storefront')).toBe('RDPARTYSTO');
  });
});

describe('BasicsSchema', () => {
  it('accepts a valid project', () => {
    expect(
      BasicsSchema.safeParse({ name: 'Shop', key: 'SHOP', baseUrl: 'http://127.0.0.1:4400/shop' })
        .success,
    ).toBe(true);
  });
  it.each(['shop', 'S', 'TOOLONGKEY1', '1AB'])('rejects key %s', (key) => {
    expect(BasicsSchema.safeParse({ name: 'Shop', key, baseUrl: 'http://x.test' }).success).toBe(
      false,
    );
  });
  it('rejects a bad URL', () => {
    expect(
      BasicsSchema.safeParse({ name: 'Shop', key: 'SHOP', baseUrl: 'not a url' }).success,
    ).toBe(false);
  });
});

describe('EnvironmentsSchema', () => {
  it('rejects duplicate names and an empty list', () => {
    const dup = EnvironmentsSchema.safeParse({
      rows: [
        { name: 'dev', baseUrl: 'http://a.test' },
        { name: 'DEV', baseUrl: 'http://b.test' },
      ],
    });
    expect(dup.success).toBe(false);
    expect(EnvironmentsSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});

describe('thresholds', () => {
  it('keeps escalate below act when act is lowered', () => {
    expect(constrainThresholds({ act: 0.8, escalate: 0.6 }, { act: 0.55 })).toEqual({
      act: 0.55,
      escalate: 0.54,
    });
  });
  it('keeps act above escalate when escalate is raised', () => {
    expect(constrainThresholds({ act: 0.6, escalate: 0.5 }, { escalate: 0.8 })).toEqual({
      act: 0.81,
      escalate: 0.8,
    });
  });
  it('clamps to slider ranges', () => {
    expect(constrainThresholds({ act: 0.8, escalate: 0.5 }, { act: 2 }).act).toBe(0.99);
    expect(constrainThresholds({ act: 0.8, escalate: 0.5 }, { escalate: 0 }).escalate).toBe(0.1);
  });
  it('derives slider bounds from the other value', () => {
    expect(actBounds(0.5).min).toBe(0.51);
    expect(actBounds(0.1).min).toBe(0.5);
    expect(escalateBounds(0.8).max).toBe(0.79);
    expect(escalateBounds(0.95).max).toBe(0.8);
  });
  it('the models schema rejects escalate >= act', () => {
    expect(ModelsSchema.safeParse({ ...DEFAULT_MODELS, act: 0.6, escalate: 0.6 }).success).toBe(
      false,
    );
    expect(ModelsSchema.safeParse(DEFAULT_MODELS).success).toBe(true);
  });
  it('requires a model id once a base URL is given', () => {
    const r = ModelsSchema.safeParse({
      ...DEFAULT_MODELS,
      s1: { ...DEFAULT_MODELS.s1, baseUrl: 'http://localhost:8000' },
    });
    expect(r.success).toBe(false);
  });
});

describe('apiKeyRefFrom', () => {
  it('only accepts env: and secret: references', () => {
    expect(apiKeyRefFrom('env:S1PILOT_API_KEY')).toBe('env:S1PILOT_API_KEY');
    expect(apiKeyRefFrom('secret:openai')).toBe('secret:openai');
    expect(apiKeyRefFrom('sk-live-123')).toBeUndefined();
    expect(apiKeyRefFrom('')).toBeUndefined();
  });
});

describe('draft storage', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('round-trips and merges onto defaults', () => {
    saveDraft({
      ...EMPTY_DRAFT,
      createdKey: 'SHOP',
      basics: { ...EMPTY_DRAFT.basics, name: 'Shop' },
    });
    const d = loadDraft();
    expect(d.createdKey).toBe('SHOP');
    expect(d.basics.name).toBe('Shop');
    expect(d.models.act).toBe(0.8);
  });

  it('survives corrupt storage and can be cleared', () => {
    window.sessionStorage.setItem('s1pilot.wizard.draft', '{oops');
    expect(loadDraft()).toEqual(EMPTY_DRAFT);
    saveDraft({ ...EMPTY_DRAFT, createdKey: 'X1' });
    clearDraft();
    expect(loadDraft().createdKey).toBeUndefined();
  });
});
