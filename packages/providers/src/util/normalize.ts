import { S1PilotError, applyTemperatureToRecord, type DecideAnswer, type Question } from '@s1pilot/domain';

/** What an adapter extracted from a model response, before normalisation. */
export interface RawAnswer {
  choice?: string;
  score?: number;
  /** P(true) for `noul` questions. */
  noul?: number;
  probabilities?: Record<string, number>;
}

function bad(message: string, details?: Record<string, unknown>): never {
  throw new S1PilotError('MODEL_BAD_RESPONSE', message, details);
}

/** Scales non-negative weights so they sum to 1. Throws `MODEL_BAD_RESPONSE` on negative/NaN/all-zero input. */
export function normalizeProbabilities(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights);
  if (entries.length === 0) return bad('Model returned no probabilities');
  let sum = 0;
  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value < 0) return bad(`Invalid probability for "${key}"`, { key });
    sum += value;
  }
  if (sum === 0) return bad('Model returned probabilities that are all zero');
  return Object.fromEntries(entries.map(([key, value]) => [key, value / sum]));
}

/** First key with the highest probability (ties keep insertion order). */
function argmax(probabilities: Record<string, number>): string {
  let best = '';
  let bestValue = -1;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/**
 * Turns a raw model answer into a `DecideAnswer`: probabilities sum to 1, `confidence = max(p)`.
 * - `choice`: probabilities over the question's option ids (missing options get 0).
 * - `noul`: `{ noul: P(true), probabilities: { true, false } }`.
 * - `score`: probabilities over the criteria levels; `score` is the index of the chosen level.
 */
export function normalizeAnswer(question: Question, raw: RawAnswer): DecideAnswer {
  if (question.type === 'noul') {
    const given = raw.noul ?? trueShare(raw.probabilities);
    if (given === undefined) return bad('Model returned no P(true) for a noul question');
    if (!Number.isFinite(given) || given < 0 || given > 1) return bad(`P(true) out of range: ${given}`);
    const probabilities = { true: given, false: 1 - given };
    return { noul: given, probabilities, confidence: Math.max(given, 1 - given) };
  }

  const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria;
  if (raw.probabilities === undefined) {
    if (question.type === 'score' && raw.score !== undefined) {
      const index = Math.min(labels.length - 1, Math.max(0, Math.round(raw.score)));
      const one = Object.fromEntries(labels.map((label, i) => [label, i === index ? 1 : 0]));
      return { score: index, probabilities: one, confidence: 1 };
    }
    return bad('Model returned no probabilities');
  }
  for (const key of Object.keys(raw.probabilities)) {
    if (!labels.includes(key)) return bad(`Model answered with unknown option "${key}"`, { key });
  }
  const filled = Object.fromEntries(labels.map((label) => [label, raw.probabilities?.[label] ?? 0]));
  const probabilities = normalizeProbabilities(filled);
  const top = argmax(probabilities);
  const confidence = probabilities[top] ?? 0;

  if (question.type === 'choice') {
    if (raw.choice !== undefined && !labels.includes(raw.choice)) {
      return bad(`Model chose unknown option "${raw.choice}"`, { choice: raw.choice });
    }
    return { choice: raw.choice ?? top, probabilities, confidence };
  }
  return { score: raw.score ?? labels.indexOf(top), probabilities, confidence };
}

function trueShare(probabilities: Record<string, number> | undefined): number | undefined {
  const yes = probabilities?.['true'];
  if (yes === undefined) return undefined;
  const no = probabilities?.['false'];
  if (no === undefined) return yes;
  return yes + no === 0 ? undefined : yes / (yes + no);
}

/**
 * Applies a calibration temperature (`p^(1/T)` renormalised) to a normalised answer. The pre-calibration
 * output is kept in `raw` so decision records can store both. `T = 1` returns the answer unchanged.
 */
export function calibrateAnswer(question: Question, answer: DecideAnswer, T: number): DecideAnswer {
  if (T === 1) return answer;
  const probabilities = applyTemperatureToRecord(answer.probabilities, T);
  const confidence = Math.max(0, ...Object.values(probabilities));
  const raw = answer.raw ?? { probabilities: answer.probabilities, confidence: answer.confidence };
  return {
    ...answer,
    ...(question.type === 'noul' ? { noul: probabilities['true'] ?? answer.noul ?? 0 } : {}),
    probabilities,
    confidence,
    raw,
  };
}
