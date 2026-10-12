import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CapabilitiesSchema } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { listProfiles, loadProfile } from './profiles.js';

describe('profiles', () => {
  it('ships clef, clef-flash, jev, jev-9b and laya', () => {
    expect(listProfiles().map((p) => p.id)).toEqual(['clef', 'clef-flash', 'jev', 'jev-9b', 'laya']);
  });

  it.each(['clef', 'clef-flash', 'jev', 'jev-9b', 'laya'])('%s validates against CapabilitiesSchema', (id) => {
    const profile = loadProfile(id);
    expect(profile.id).toBe(id);
    expect(CapabilitiesSchema.safeParse(profile.capabilities).success).toBe(true);
    expect(profile.thresholds.fail).toBeLessThanOrEqual(profile.thresholds.pass);
  });

  it('encodes the reference limits and recommended adapters', () => {
    expect(loadProfile('jev').capabilities.maxOptions).toBe(255); // the OpenRouter decisions endpoint rejects more than 255 choices
    expect(loadProfile('laya').capabilities.maxOptions).toBe(20);
    expect(loadProfile('clef').capabilities.maxOptions).toBe(64);
    expect(loadProfile('jev').recommendedAdapter).toBe('decide');
    expect(loadProfile('jev').capabilities.multiQuestionPerCall).toBe(false);
    expect(loadProfile('laya').recommendedAdapter).toBe('systemone');
    expect(loadProfile('laya').thresholds.act).toBeGreaterThan(loadProfile('clef').thresholds.act);
  });

  it('rejects unknown and malformed ids without touching the filesystem outside the profiles dir', () => {
    expect(() => loadProfile('nope')).toThrowError(expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }));
    expect(() => loadProfile('../package')).toThrowError(expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }));
  });

  it('loads from a custom directory and validates the content', () => {
    const dir = mkdtempSync(join(tmpdir(), 's1pilot-profiles-'));
    try {
      writeFileSync(join(dir, 'broken.json'), JSON.stringify({ id: 'broken', name: 'x' }));
      expect(() => loadProfile('broken', dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
