import { repos, type Db } from '@s1pilot/db';
import {
  CalibrationStateSchema,
  Calibrator,
  applyTemperature,
  eceOf,
  fitCalibrationModels,
  reliabilityBins,
  suggestThresholds,
  type CalibrationQuestionType,
  type CalibrationSample,
  type CalibrationState,
  type ReliabilityBin,
  type ReviewItem,
  type ThresholdSample,
  type Thresholds,
} from '@s1pilot/domain';

/** Settings key of the stored calibration of a project. */
export const calibrationKeyFor = (projectId: string): string => `calibration:${projectId}`;

/** The stored calibration state of a project, or `undefined` before the first fit. */
export async function loadCalibrationState(db: Db, projectId: string): Promise<CalibrationState | undefined> {
  const parsed = CalibrationStateSchema.safeParse(await repos.settings.get(db, calibrationKeyFor(projectId)));
  return parsed.success ? parsed.data : undefined;
}

/** The calibrator runs of this project use (identity when nothing was fitted). */
export async function loadCalibrator(db: Db, projectId: string): Promise<Calibrator> {
  return new Calibrator((await loadCalibrationState(db, projectId))?.models ?? []);
}

/** Sample from the note of a `decision` item written by live approvals (S-037). */
function decisionSample(item: ReviewItem): CalibrationSample | undefined {
  if (item.kind !== 'decision' || !item.note) return undefined;
  try {
    const note = JSON.parse(item.note) as { probabilities?: Record<string, number>; humanChoice?: string };
    const entries = Object.entries(note.probabilities ?? {});
    const label = entries.findIndex(([key]) => key === note.humanChoice);
    if (entries.length < 2 || label < 0) return undefined;
    return { model: null, questionType: 'choice', probabilities: entries.map(([, p]) => p), label };
  } catch {
    return undefined;
  }
}

/**
 * Reviewed data of a project: verdict outcomes (human review S-047 and overrides S-046) as `noul` samples and
 * live approvals (S-037) as `choice` samples. Probabilities are the model's raw output.
 */
export async function collectSamples(db: Db, projectId: string, items?: ReviewItem[]): Promise<CalibrationSample[]> {
  const all = items ?? (await repos.reviews.list(db, { projectId }));
  const out: CalibrationSample[] = [];
  for (const item of all) {
    if (item.status === 'pending') continue;
    if (item.kind === 'decision') {
      const s = decisionSample(item);
      if (s) out.push(s);
      continue;
    }
    const o = item.outcome;
    if (item.kind !== 'verdict' || !o || o.pTrue === null) continue;
    out.push({
      model: o.model,
      questionType: o.questionType as CalibrationQuestionType,
      probabilities: [o.pTrue, 1 - o.pTrue],
      label: o.humanVerdict === 'passed' ? 0 : 1,
    });
  }
  return out;
}

/** ECE and reliability bins of `samples`, before and after the calibrator. */
export function evaluate(
  samples: CalibrationSample[],
  calibrator: Calibrator,
): { eceBefore: number | null; eceAfter: number | null; reliabilityBefore: ReliabilityBin[]; reliabilityAfter: ReliabilityBin[] } {
  const view = (apply: boolean): Array<{ confidence: number; correct: boolean }> =>
    samples.map((s) => {
      const T = apply ? calibrator.temperature(s.model ?? '*', s.questionType, s.probabilities.length) : 1;
      const p = applyTemperature(s.probabilities, T);
      let best = 0;
      for (let i = 1; i < p.length; i++) if ((p[i] ?? 0) > (p[best] ?? 0)) best = i;
      return { confidence: p[best] ?? 0, correct: best === s.label };
    });
  const before = view(false);
  const after = view(true);
  return {
    eceBefore: eceOf(before),
    eceAfter: eceOf(after),
    reliabilityBefore: reliabilityBins(before),
    reliabilityAfter: reliabilityBins(after),
  };
}

/** Verdict samples as calibrated P(true) vs the human result, for threshold suggestions. */
export function thresholdSamples(samples: CalibrationSample[], calibrator: Calibrator): ThresholdSample[] {
  return samples
    .filter((s) => s.questionType === 'noul')
    .map((s) => ({
      pTrue: applyTemperature(s.probabilities, calibrator.temperature(s.model ?? '*', 'noul', 2))[0] ?? 0,
      humanPassed: s.label === 0,
    }));
}

/**
 * Fits and stores the calibration of a project from its reviewed data. The previous `lastTunedAt` is kept.
 * The threshold suggestion is stored only; it is never applied here.
 */
export async function fitProject(
  db: Db,
  projectId: string,
  currentThresholds: Pick<Thresholds, 'pass' | 'fail'>,
  now = new Date().toISOString(),
): Promise<CalibrationState> {
  const samples = await collectSamples(db, projectId);
  const models = fitCalibrationModels(samples, now);
  const calibrator = new Calibrator(models);
  const previous = await loadCalibrationState(db, projectId);
  const state: CalibrationState = {
    models,
    fittedAt: now,
    samples: samples.length,
    suggestion: suggestThresholds(thresholdSamples(samples, calibrator), currentThresholds),
    lastTunedAt: previous?.lastTunedAt ?? null,
  };
  await repos.settings.set(db, calibrationKeyFor(projectId), state);
  return state;
}
