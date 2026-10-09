import { Calibrator, type DecideRequest } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { MOCK_CAPABILITIES, MockDecisionModel } from '../adapters/mock.js';
import { createDecisionModel } from '../registry.js';

import { calibratedDecisionModel } from './calibrated.js';

const NOW = '2026-10-09T00:00:00.000Z';
const calibrator = new Calibrator([{ key: 'clef|noul|2', T: 2, n: 80, eceBefore: 0.2, eceAfter: 0.02, fittedAt: NOW }]);
const req: DecideRequest = {
  state: {},
  questions: {
    q: { type: 'noul', instructions: 'Is it true?' },
    pick: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B', c: 'C' } },
  },
};

function inner(): MockDecisionModel {
  return new MockDecisionModel({
    capabilities: MOCK_CAPABILITIES,
    script: [
      { match: (_q, _s, id) => id === 'q', answer: { noul: 0.9 } },
      { match: (_q, _s, id) => id === 'pick', answer: { choice: 'a', probabilities: { a: 0.8, b: 0.1, c: 0.1 } } },
    ],
  });
}

describe('calibratedDecisionModel', () => {
  it('applies the fitted temperature and keeps the raw output', async () => {
    const model = calibratedDecisionModel(inner(), 'clef', calibrator);
    const out = await model.decide(req);
    expect(out['q']?.noul).toBeCloseTo(0.75, 5);
    expect(out['q']?.confidence).toBeCloseTo(0.75, 5);
    expect(out['q']?.raw?.probabilities['true']).toBeCloseTo(0.9, 5);
    expect(out['q']?.raw?.confidence).toBeCloseTo(0.9, 5);
    // No bucket for choice questions: untouched, no raw.
    expect(out['pick']?.raw).toBeUndefined();
    expect(out['pick']?.choice).toBe('a');
  });

  it('leaves answers alone for models without a calibration', async () => {
    const out = await calibratedDecisionModel(inner(), 'other', calibrator).decide(req);
    expect(out['q']?.noul).toBeCloseTo(0.9, 5);
    expect(out['q']?.raw).toBeUndefined();
  });

  it('is wired through createDecisionModel({ calibrator })', async () => {
    const mock = inner();
    const model = createDecisionModel({ adapter: 'mock', model: 'clef' }, { mock, calibrator });
    const out = await model.decide(req);
    expect(out['q']?.noul).toBeCloseTo(0.75, 5);
    expect(out['q']?.raw).toBeDefined();
  });
});
