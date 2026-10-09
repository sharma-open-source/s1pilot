import { describe, expect, it } from 'vitest';

import {
  Calibrator,
  applyTemperature,
  calibrationKey,
  eceAtTemperature,
  fitCalibrationModels,
  fitTemperature,
  optionCountBucket,
  reliabilityBins,
  suggestThresholds,
  type CalibrationSample,
} from './calibration.js';

/** Unwraps a value the test expects to exist. */
function def<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

const NOW = '2026-10-09T00:00:00.000Z';

/** `n` binary samples where the model says P(true) = `p` and a share `acc` of them are true. */
function binary(n: number, p: number, acc: number, model = 'clef'): CalibrationSample[] {
  return Array.from({ length: n }, (_, i) => ({
    model,
    questionType: 'noul' as const,
    probabilities: [p, 1 - p],
    label: i < Math.round(n * acc) ? 0 : 1,
  }));
}

describe('temperature scaling', () => {
  it('flattens with T > 1 and keeps the ranking', () => {
    const out = applyTemperature([0.9, 0.1], 2);
    expect(out[0]).toBeCloseTo(0.75, 5);
    expect(def(out[0]) + def(out[1])).toBeCloseTo(1, 10);
    expect(applyTemperature([0.9, 0.1], 1)).toEqual([0.9, 0.1]);
  });

  it('over-confident data (70% right at p = 0.9) fits T > 1 and lowers the ECE', () => {
    const samples = binary(200, 0.9, 0.7);
    const T = fitTemperature(samples);
    expect(T).toBeGreaterThan(1);
    expect(def(eceAtTemperature(samples, T))).toBeLessThan(def(eceAtTemperature(samples, 1)));
    expect(eceAtTemperature(samples, 1)).toBeCloseTo(0.2, 2);
    expect(def(eceAtTemperature(samples, T))).toBeLessThan(0.05);
  });

  it('under-confident data fits T < 1', () => {
    expect(fitTemperature(binary(200, 0.6, 0.95))).toBeLessThan(1);
  });

  it('well calibrated data stays near T = 1', () => {
    expect(fitTemperature(binary(200, 0.8, 0.8))).toBeCloseTo(1, 1);
  });

  it('buckets option counts', () => {
    expect([2, 3, 4, 5, 9].map(optionCountBucket)).toEqual(['2', '3-4', '3-4', '5+', '5+']);
  });
});

describe('fitCalibrationModels and Calibrator', () => {
  it('needs 50 samples per bucket and falls back to a coarser bucket, then T = 1', () => {
    const noul = binary(60, 0.9, 0.7);
    const choice: CalibrationSample[] = Array.from({ length: 20 }, () => ({
      model: 'clef',
      questionType: 'choice',
      probabilities: [0.9, 0.05, 0.05],
      label: 1,
    }));
    const models = fitCalibrationModels([...noul, ...choice], NOW);
    const keys = models.map((m) => m.key);
    expect(keys).toContain(calibrationKey({ model: 'clef', questionType: 'noul', bucket: '2' }));
    expect(keys).toContain(calibrationKey({ model: 'clef', questionType: '*', bucket: '*' }));
    // 20 choice samples are below the minimum: no choice-specific model.
    expect(keys.some((k) => k.startsWith('clef|choice'))).toBe(false);

    const calibrator = new Calibrator(models);
    expect(calibrator.temperature('clef', 'noul', 2)).toBeGreaterThan(1);
    // choice falls back to the model-wide bucket, an unknown model to T = 1.
    expect(calibrator.temperature('clef', 'choice', 3)).toBe(def(models.find((m) => m.key === 'clef|*|*')).T);
    expect(calibrator.temperature('other', 'noul', 2)).toBe(1);
    expect(fitCalibrationModels(binary(49, 0.9, 0.7), NOW)).toEqual([]);
  });

  it('records ECE before and after', () => {
    const m = def(fitCalibrationModels(binary(100, 0.9, 0.7), NOW)[0]);
    expect(m.n).toBe(100);
    expect(m.eceAfter).toBeLessThan(m.eceBefore);
  });

  it('calibrates a probability record', () => {
    const c = new Calibrator([{ key: 'm|noul|2', T: 2, n: 60, eceBefore: 0.2, eceAfter: 0.01, fittedAt: NOW }]);
    const out = c.calibrate('m', 'noul', { true: 0.9, false: 0.1 });
    expect(out['true']).toBeCloseTo(0.75, 5);
  });
});

describe('reliability bins', () => {
  it('reports per-bin confidence and accuracy', () => {
    const bins = reliabilityBins([
      { confidence: 0.95, correct: true },
      { confidence: 0.91, correct: false },
      { confidence: 0.55, correct: true },
    ]);
    expect(bins).toHaveLength(10);
    expect(bins[9]).toMatchObject({ n: 2, accuracy: 0.5 });
    expect(bins[5]).toMatchObject({ n: 1, accuracy: 1 });
    expect(bins[0]).toMatchObject({ n: 0, confidence: null });
  });
});

describe('suggestThresholds', () => {
  const current = { pass: 0.8, fail: 0.2 };
  it('picks the lowest pass with <= 1% false passes', () => {
    const samples = [
      ...Array.from({ length: 30 }, () => ({ pTrue: 0.99, humanPassed: true })),
      ...Array.from({ length: 30 }, (_, i) => ({ pTrue: 0.7, humanPassed: i < 20 })),
      ...Array.from({ length: 30 }, () => ({ pTrue: 0.05, humanPassed: false })),
    ];
    const s = def(suggestThresholds(samples, current));
    expect(s.pass).toBe(0.99);
    expect(s.falsePassRate).toBeLessThanOrEqual(0.01);
    expect(s.fail).toBeLessThanOrEqual(s.pass);
  });

  it('returns null with too little data or when the target is unreachable', () => {
    expect(suggestThresholds([{ pTrue: 0.9, humanPassed: true }], current)).toBeNull();
    const bad = Array.from({ length: 100 }, (_, i) => ({ pTrue: 0.9, humanPassed: i % 2 === 0 }));
    expect(suggestThresholds(bad, current)).toBeNull();
  });
});
