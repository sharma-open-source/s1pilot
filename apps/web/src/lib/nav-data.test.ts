import { describe, expect, it } from 'vitest';

import { parseBadges } from './nav-data';

describe('parseBadges', () => {
  it('reads the server workspace message', () => {
    expect(parseBadges({ type: 'workspace', liveRuns: 2, reviewCount: 5 })).toEqual({ liveRuns: 2, reviewCount: 5 });
  });

  it('ignores other message types and malformed input', () => {
    expect(parseBadges({ type: 'run.status', runId: 'r1', status: 'running' })).toEqual({});
    expect(parseBadges({ liveRuns: 1 })).toEqual({});
    expect(parseBadges(null)).toEqual({});
    expect(parseBadges({ type: 'workspace', liveRuns: '2' })).toEqual({});
  });
});
