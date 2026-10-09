import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';
import type { Thresholds } from './model-settings.js';

/** Minimum number of reviewed samples a bucket needs before a temperature is fitted for it (plan section 2.4). */
export const CALIBRATION_MIN_SAMPLES = 50;
/** Target share of human-failed results that the suggested `pass` threshold may still let through. */
export const FALSE_PASS_TARGET = 0.01;
/** Smallest number of samples that must sit beyond a suggested threshold for the suggestion to be trusted. */
const MIN_THRESHOLD_SUPPORT = 20;

export const CalibrationQuestionTypeSchema = z.enum(['noul', 'choice', 'score']);
export type CalibrationQuestionType = z.infer<typeof CalibrationQuestionTypeSchema>;

/** Option-count bucket of a question: `2`, `3-4` or `5+`. */
export type OptionCountBucket = '2' | '3-4' | '5+';

/** Buckets option counts so rare sizes share one temperature. */
export function optionCountBucket(count: number): OptionCountBucket {
  return count <= 2 ? '2' : count <= 4 ? '3-4' : '5+';
}

/** Where a temperature applies. `*` is a wildcard used for the coarser fall-back buckets. */
export interface CalibrationKeyParts {
  model: string;
  questionType: CalibrationQuestionType | '*';
  bucket: OptionCountBucket | '*';
}

/** Stable string key `model|questionType|bucket` of a calibration model. */
export function calibrationKey(parts: CalibrationKeyParts): string {
  return `${parts.model}|${parts.questionType}|${parts.bucket}`;
}

export const CalibrationModelSchema = z.object({
  key: z.string().min(1),
  /** Temperature; > 1 softens over-confident probabilities, < 1 sharpens under-confident ones. */
  T: z.number().positive(),
  n: z.number().int().min(0),
  eceBefore: z.number().min(0).max(1),
  eceAfter: z.number().min(0).max(1),
  fittedAt: IsoTimestampSchema,
});
export type CalibrationModel = z.infer<typeof CalibrationModelSchema>;

/** One reviewed decision: the model's raw probabilities over the options and the index of the right option. */
export interface CalibrationSample {
  model: string | null;
  questionType: CalibrationQuestionType;
  /** Raw (uncalibrated) probabilities over the options. */
  probabilities: number[];
  /** Index of the option the human judged correct. */
  label: number;
}

const EPS = 1e-9;

/** `p_i^(1/T)` renormalised. `T = 1` returns the input unchanged. */
export function applyTemperature(probabilities: number[], T: number): number[] {
  if (T === 1 || probabilities.length === 0) return probabilities;
  const powered = probabilities.map((p) => Math.pow(Math.max(p, EPS), 1 / T));
  const sum = powered.reduce((a, b) => a + b, 0);
  return powered.map((p) => p / sum);
}

/** Same as {@link applyTemperature} for a keyed probability record. */
export function applyTemperatureToRecord(probabilities: Record<string, number>, T: number): Record<string, number> {
  const keys = Object.keys(probabilities);
  const out = applyTemperature(
    keys.map((k) => probabilities[k] ?? 0),
    T,
  );
  return Object.fromEntries(keys.map((k, i) => [k, out[i] ?? 0]));
}

/** Mean negative log-likelihood of the labels under temperature `T`. */
export function negativeLogLikelihood(samples: CalibrationSample[], T: number): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const s of samples) {
    const p = applyTemperature(s.probabilities, T)[s.label] ?? 0;
    total -= Math.log(Math.max(p, EPS));
  }
  return total / samples.length;
}

/**
 * Fits the temperature that minimises the NLL with a golden-section search over `log T` in
 * `[ln 0.1, ln 20]`. Returns 1 without samples.
 */
export function fitTemperature(samples: CalibrationSample[]): number {
  if (samples.length === 0) return 1;
  const phi = (Math.sqrt(5) - 1) / 2;
  let lo = Math.log(0.1);
  let hi = Math.log(20);
  const f = (x: number): number => negativeLogLikelihood(samples, Math.exp(x));
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = f(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = f(x2);
    }
  }
  return Math.exp((lo + hi) / 2);
}

/** One bin of a reliability diagram. */
export interface ReliabilityBin {
  /** Lower edge (inclusive) and upper edge (exclusive, except the last bin) of the confidence range. */
  from: number;
  to: number;
  n: number;
  /** Mean confidence of the samples in the bin (`null` when empty). */
  confidence: number | null;
  /** Share of correct samples in the bin (`null` when empty). */
  accuracy: number | null;
}

/** Reliability bins of `(confidence, correct)` pairs (10 equal-width bins by default). */
export function reliabilityBins(samples: Array<{ confidence: number; correct: boolean }>, bins = 10): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, () => ({ n: 0, conf: 0, ok: 0 }));
  for (const s of samples) {
    const b = acc[Math.min(bins - 1, Math.floor(s.confidence * bins))];
    if (!b) continue;
    b.n += 1;
    b.conf += s.confidence;
    if (s.correct) b.ok += 1;
  }
  return acc.map((b, i) => ({
    from: i / bins,
    to: (i + 1) / bins,
    n: b.n,
    confidence: b.n === 0 ? null : b.conf / b.n,
    accuracy: b.n === 0 ? null : b.ok / b.n,
  }));
}

/** Expected calibration error over equal-width confidence bins; `null` without samples. */
export function eceOf(samples: Array<{ confidence: number; correct: boolean }>, bins = 10): number | null {
  if (samples.length === 0) return null;
  let total = 0;
  for (const b of reliabilityBins(samples, bins)) {
    if (b.n === 0 || b.confidence === null || b.accuracy === null) continue;
    total += (b.n / samples.length) * Math.abs(b.accuracy - b.confidence);
  }
  return total;
}

function confidenceSamples(samples: CalibrationSample[], T: number): Array<{ confidence: number; correct: boolean }> {
  return samples.map((s) => {
    const p = applyTemperature(s.probabilities, T);
    let best = 0;
    for (let i = 1; i < p.length; i++) if ((p[i] ?? 0) > (p[best] ?? 0)) best = i;
    return { confidence: p[best] ?? 0, correct: best === s.label };
  });
}

/** ECE of `samples` after applying temperature `T` (`null` without samples). */
export function eceAtTemperature(samples: CalibrationSample[], T: number): number | null {
  return eceOf(confidenceSamples(samples, T));
}

/** Reliability bins of `samples` after applying temperature `T`. */
export function reliabilityAtTemperature(samples: CalibrationSample[], T: number): ReliabilityBin[] {
  return reliabilityBins(confidenceSamples(samples, T));
}

function groupBy(samples: CalibrationSample[], keyOf: (s: CalibrationSample) => string): Map<string, CalibrationSample[]> {
  const out = new Map<string, CalibrationSample[]>();
  for (const s of samples) {
    const k = keyOf(s);
    const list = out.get(k);
    if (list) list.push(s);
    else out.set(k, [s]);
  }
  return out;
}

/**
 * Fits one {@link CalibrationModel} for every bucket that has at least {@link CALIBRATION_MIN_SAMPLES} samples:
 * `(model, questionType, optionCountBucket)` and the coarser `(model, questionType, *)` and `(model, *, *)`.
 * Smaller buckets get no model; {@link Calibrator} falls back to a coarser one or `T = 1`.
 */
export function fitCalibrationModels(samples: CalibrationSample[], now: string, minSamples = CALIBRATION_MIN_SAMPLES): CalibrationModel[] {
  const levels: Array<(s: CalibrationSample) => string> = [
    (s) => calibrationKey({ model: s.model ?? '*', questionType: s.questionType, bucket: optionCountBucket(s.probabilities.length) }),
    (s) => calibrationKey({ model: s.model ?? '*', questionType: s.questionType, bucket: '*' }),
    (s) => calibrationKey({ model: s.model ?? '*', questionType: '*', bucket: '*' }),
  ];
  const models = new Map<string, CalibrationModel>();
  for (const keyOf of levels) {
    for (const [key, group] of groupBy(samples, keyOf)) {
      if (group.length < minSamples || models.has(key)) continue;
      const T = fitTemperature(group);
      models.set(key, {
        key,
        T,
        n: group.length,
        eceBefore: eceAtTemperature(group, 1) ?? 0,
        eceAfter: eceAtTemperature(group, T) ?? 0,
        fittedAt: now,
      });
    }
  }
  return [...models.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Resolves the temperature for a question: finest matching bucket, then coarser ones, else `T = 1`. */
export class Calibrator {
  private readonly byKey: Map<string, CalibrationModel>;

  constructor(models: CalibrationModel[]) {
    this.byKey = new Map(models.map((m) => [m.key, m]));
  }

  /** The model that applies to the question, or `undefined` when none was fitted. */
  find(model: string, questionType: CalibrationQuestionType, optionCount: number): CalibrationModel | undefined {
    return (
      this.byKey.get(calibrationKey({ model, questionType, bucket: optionCountBucket(optionCount) })) ??
      this.byKey.get(calibrationKey({ model, questionType, bucket: '*' })) ??
      this.byKey.get(calibrationKey({ model, questionType: '*', bucket: '*' }))
    );
  }

  /** Temperature for a question (1 when no bucket qualifies). */
  temperature(model: string, questionType: CalibrationQuestionType, optionCount: number): number {
    return this.find(model, questionType, optionCount)?.T ?? 1;
  }

  /** Calibrated copy of `probabilities` for a question. */
  calibrate(model: string, questionType: CalibrationQuestionType, probabilities: Record<string, number>): Record<string, number> {
    return applyTemperatureToRecord(probabilities, this.temperature(model, questionType, Object.keys(probabilities).length));
  }
}

/** Reviewed pass/fail samples used to suggest thresholds. */
export interface ThresholdSample {
  /** Calibrated P(true) of the assertion. */
  pTrue: number;
  humanPassed: boolean;
}

export const ThresholdSuggestionSchema = z.object({
  pass: z.number(),
  fail: z.number(),
  /** Number of reviewed results the suggestion is based on. */
  n: z.number(),
  /** Share of human-failed results with `pTrue >= pass` (false passes). */
  falsePassRate: z.number(),
  /** Share of human-passed results with `pTrue <= fail` (false fails). */
  falseFailRate: z.number(),
});
export type ThresholdSuggestion = z.infer<typeof ThresholdSuggestionSchema>;

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Suggests `pass` / `fail` thresholds so that results above `pass` are wrongly passed at most `target` of the
 * time (and symmetrically for `fail`). Picks the lowest such `pass` (most automation). Returns `null` when
 * there are fewer than `minSamples` samples or no threshold reaches the target. Never applied automatically.
 */
export function suggestThresholds(
  samples: ThresholdSample[],
  current: Pick<Thresholds, 'pass' | 'fail'>,
  target = FALSE_PASS_TARGET,
  minSamples = CALIBRATION_MIN_SAMPLES,
): ThresholdSuggestion | null {
  if (samples.length < minSamples) return null;
  const values = [...new Set(samples.map((s) => s.pTrue))].sort((a, b) => a - b);

  let pass: number | undefined;
  for (const t of values) {
    const above = samples.filter((s) => s.pTrue >= t);
    if (above.length < MIN_THRESHOLD_SUPPORT) break;
    if (above.filter((s) => !s.humanPassed).length / above.length <= target) {
      pass = t;
      break;
    }
  }
  if (pass === undefined) return null;
  pass = Math.max(pass, 0.5);

  let fail: number | undefined;
  for (const t of [...values].reverse()) {
    const below = samples.filter((s) => s.pTrue <= t);
    if (below.length < MIN_THRESHOLD_SUPPORT) break;
    if (below.filter((s) => s.humanPassed).length / below.length <= target) {
      fail = t;
      break;
    }
  }
  fail = Math.min(fail ?? current.fail, pass, 0.5);

  const above = samples.filter((s) => s.pTrue >= pass);
  const below = samples.filter((s) => s.pTrue <= fail);
  return {
    pass: round(pass),
    fail: round(fail),
    n: samples.length,
    falsePassRate: above.length === 0 ? 0 : above.filter((s) => !s.humanPassed).length / above.length,
    falseFailRate: below.length === 0 ? 0 : below.filter((s) => s.humanPassed).length / below.length,
  };
}

/** Everything stored per project by `calibration.fit`. */
export const CalibrationStateSchema = z.object({
  models: z.array(CalibrationModelSchema),
  fittedAt: IsoTimestampSchema,
  /** Reviewed samples the fit used. */
  samples: z.number().int().min(0),
  suggestion: ThresholdSuggestionSchema.nullable(),
  /** When the user last applied suggested thresholds. */
  lastTunedAt: IsoTimestampSchema.nullable().default(null),
});
export type CalibrationState = z.infer<typeof CalibrationStateSchema>;
