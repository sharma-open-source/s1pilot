import type { DecideAnswer, DecideRequest, DecisionModel, Question } from '@s1pilot/domain';

/** An answer combined from two differently-ordered calls. */
export interface DualOrderAnswer extends DecideAnswer {
  /** True when the two calls' top choices differ; callers must treat it as below the act threshold. */
  disagreement: boolean;
}

export interface DualOrderOptions {
  /** `'reverse'` (default) or a numeric seed for a deterministic shuffle of the option order. */
  order?: 'reverse' | { seed: number };
}

/** mulberry32 PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reorder(ids: string[], order: DualOrderOptions['order']): string[] {
  if (order === undefined || order === 'reverse') return [...ids].reverse();
  const next = rng(order.seed);
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
}

function reorderQuestion(question: Question, order: DualOrderOptions['order']): Question {
  if (question.type !== 'choice') return question;
  const criteria: Record<string, string> = {};
  for (const id of reorder(Object.keys(question.criteria), order)) criteria[id] = question.criteria[id] as string;
  return { ...question, criteria };
}

function argmax(probabilities: Record<string, number>, preferred?: string): string | undefined {
  let best: string | undefined;
  let bestP = -1;
  for (const [id, p] of Object.entries(probabilities)) {
    if (p > bestP || (p === bestP && id === preferred)) {
      best = id;
      bestP = p;
    }
  }
  return best;
}

/**
 * Decides `req` twice, the second time with every `choice` question's options reordered (reversed or
 * seeded-shuffled), and merges the results by option id: probabilities are averaged, confidence is
 * recomputed as the max averaged probability and `disagreement` flags differing top choices.
 * Only `choice` questions have an order; `noul`/`score` answers pass through from the first call
 * (with `disagreement: false`). No second call is made when there is no `choice` question.
 * Note: JS orders integer-like keys numerically, so such option ids cannot actually be reordered.
 */
export async function decideDualOrder(
  model: DecisionModel,
  req: DecideRequest,
  options: DualOrderOptions = {},
): Promise<Record<string, DualOrderAnswer>> {
  const choiceIds = Object.entries(req.questions)
    .filter(([, q]) => q.type === 'choice')
    .map(([id]) => id);
  const first = await model.decide(req);
  const result: Record<string, DualOrderAnswer> = {};
  for (const [id, answer] of Object.entries(first)) result[id] = { ...answer, disagreement: false };
  if (choiceIds.length === 0) return result;

  const questions: Record<string, Question> = {};
  for (const id of choiceIds) questions[id] = reorderQuestion(req.questions[id] as Question, options.order);
  const second = await model.decide({ ...req, questions });

  for (const id of choiceIds) {
    const a = first[id];
    const b = second[id];
    if (a === undefined || b === undefined) continue;
    const ids = new Set([...Object.keys(a.probabilities), ...Object.keys(b.probabilities)]);
    const probabilities: Record<string, number> = {};
    for (const key of ids) probabilities[key] = ((a.probabilities[key] ?? 0) + (b.probabilities[key] ?? 0)) / 2;
    const choice = argmax(probabilities, a.choice);
    const confidence = choice === undefined ? 0 : (probabilities[choice] as number);
    result[id] = {
      ...a,
      ...(choice === undefined ? {} : { choice }),
      probabilities,
      confidence,
      disagreement: a.choice !== b.choice,
    };
  }
  return result;
}
