import type { Capabilities, DecideAnswer, DecisionModel, DecisionRecord } from '@s1pilot/domain';

import type { ObservedElement } from '../observer/types.js';

import { orderByRelevance } from './lexical.js';

/** Meta actions whose option slots are reserved so the final `next_action` question still fits. */
export const NARROW_META_ACTIONS: readonly string[] = ['scroll_down', 'scroll_up', 'go_back', 'step_done', 'stuck'];

/** Confidence below which the runner-up region is kept as well. */
export const NARROW_LOW_CONFIDENCE = 0.6;

/** Result of {@link narrow}. */
export interface NarrowResult {
  /** Surviving elements, most lexically relevant first. */
  candidates: ObservedElement[];
  /** One record per region question asked, in order (empty when nothing had to be narrowed). */
  trail: DecisionRecord[];
}

export interface NarrowOptions {
  /** Viewport height in CSS px for fallback bands. Default: lowest element bottom edge. */
  viewportHeight?: number;
  /** Model name stored on trail records. Default `system1`. */
  modelName?: string;
}

interface Region {
  name: string;
  elements: ObservedElement[];
}

const SAMPLE_LABELS = 3;

function label(e: ObservedElement): string {
  const raw = (e.name || e.text || e.placeholder || e.nearLabel || e.idHint || e.role).replace(/\s+/g, ' ').trim();
  return raw.length > 30 ? `${raw.slice(0, 29)}…` : raw;
}

function landmarkOf(e: ObservedElement): string {
  return e.landmark ?? 'page';
}

/** Splits (already relevance-ordered) elements into near-equal chunks of at most `size`. */
function chunk(elements: ObservedElement[], size: number, base: string): Region[] {
  const parts = Math.ceil(elements.length / size);
  const per = Math.ceil(elements.length / parts);
  const out: Region[] = [];
  for (let i = 0; i < elements.length; i += per) {
    out.push({ name: `${base} part ${out.length + 1}/${parts}`, elements: elements.slice(i, i + per) });
  }
  return out;
}

/** Groups by landmark; falls back to vertical bands, then to chunks. */
function group(elements: ObservedElement[], budget: number, viewportHeight: number | undefined): Region[] {
  const byLandmark = new Map<string, ObservedElement[]>();
  for (const e of elements) {
    const key = landmarkOf(e);
    byLandmark.set(key, [...(byLandmark.get(key) ?? []), e]);
  }
  if (byLandmark.size > 1) return [...byLandmark].map(([name, els]) => ({ name, elements: els }));

  const base = landmarkOf(elements[0] as ObservedElement);
  const height = viewportHeight ?? Math.max(1, ...elements.map((e) => e.box.y + e.box.h));
  const bands = Math.max(2, Math.ceil(elements.length / budget));
  const bandHeight = height / bands;
  const byBand = new Map<number, ObservedElement[]>();
  for (const e of elements) {
    const idx = Math.min(bands - 1, Math.max(0, Math.floor((e.box.y + e.box.h / 2) / bandHeight)));
    byBand.set(idx, [...(byBand.get(idx) ?? []), e]);
  }
  if (byBand.size > 1) {
    return [...byBand]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, els]) => ({ name: `${base} band ${idx + 1}/${bands}`, elements: els }));
  }
  return chunk(elements, budget, base);
}

/**
 * Coarse-to-fine narrowing (plan sections 4.3 and 6): keeps every `choice` question within `caps.maxOptions`.
 *
 * Slots for {@link NARROW_META_ACTIONS} are reserved, so at most `maxOptions - 5` elements are returned.
 * When more elements exist they are grouped by landmark (fallback: vertical bands, then chunks), the model
 * is asked "Which region most likely contains the control for: <step>?" with region names, element counts
 * and sample labels, and the search recurses into the chosen region. If the top region's confidence is
 * below 0.6 the runner-up is merged in when the union still fits. Regions and elements are ordered by
 * lexical overlap with the step text, most relevant first. Every region question is returned in `trail`.
 *
 * @param obs Observation (only `elements` is used).
 * @param caps Model capabilities (`maxOptions`).
 * @param model System 1 model used for region questions.
 * @param stepText Natural-language test step.
 * @param options Optional viewport height and model name for trail records.
 */
export async function narrow(
  obs: { elements: readonly ObservedElement[] },
  caps: Pick<Capabilities, 'maxOptions'>,
  model: Pick<DecisionModel, 'decide'>,
  stepText: string,
  options: NarrowOptions = {},
): Promise<NarrowResult> {
  const maxOptions = Math.max(2, caps.maxOptions);
  const budget = Math.max(1, maxOptions - NARROW_META_ACTIONS.length);
  const trail: DecisionRecord[] = [];
  const modelName = options.modelName ?? 'system1';
  const { ordered, scores } = orderByRelevance(obs.elements, stepText);
  const rank = new Map(ordered.map((e, i) => [e.id, i]));
  const byRank = (els: ObservedElement[]): ObservedElement[] =>
    [...els].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const best = (r: Region): number => Math.max(0, ...r.elements.map((e) => scores.get(e.id) ?? 0));

  /** Asks the model to choose among `regions` (at most maxOptions); returns the picked ones, best first. */
  async function ask(regions: Region[]): Promise<Region[]> {
    const sorted = [...regions].sort((a, b) => best(b) - best(a));
    const criteria: Record<string, string> = {};
    sorted.forEach((r, i) => {
      const samples = byRank(r.elements).slice(0, SAMPLE_LABELS).map(label).join(', ');
      criteria[`r${i + 1}`] = `${r.name} (${r.elements.length} elements): ${samples}`;
    });
    const questionId = `narrow-region-${trail.length + 1}`;
    const started = Date.now();
    const answers = await model.decide({
      state: { step: stepText },
      questions: {
        [questionId]: { type: 'choice', instructions: `Which region most likely contains the control for: ${stepText}?`, criteria },
      },
    });
    const answer: DecideAnswer | undefined = answers[questionId];
    const ids = Object.keys(criteria);
    const probs = answer?.probabilities ?? {};
    const ranked = ids.map((id, i) => ({ id, p: probs[id] ?? 0, i })).sort((a, b) => b.p - a.p || a.i - b.i);
    const top = answer?.choice !== undefined && ids.includes(answer.choice) ? answer.choice : (ranked[0]?.id as string);
    const confidence = answer?.confidence ?? 0;
    trail.push({
      questionId,
      options: ids,
      optionLabels: criteria,
      probabilities: probs,
      chosen: top,
      confidence,
      model: modelName,
      latencyMs: Date.now() - started,
    });
    const picked = [sorted[ids.indexOf(top)] as Region];
    if (confidence < NARROW_LOW_CONFIDENCE) {
      const second = ranked.find((r) => r.id !== top);
      if (second !== undefined) picked.push(sorted[ids.indexOf(second.id)] as Region);
    }
    return picked;
  }

  /** Reduces `regions` to one element set via (possibly multi-level) region questions. */
  async function pick(regions: Region[]): Promise<ObservedElement[]> {
    let level = regions;
    while (level.length > maxOptions) {
      // Too many regions for one question: bundle them into super-regions of up to maxOptions regions.
      const bundles: Region[] = [];
      const members: Region[][] = [];
      for (let i = 0; i < level.length; i += maxOptions) {
        const part = level.slice(i, i + maxOptions);
        members.push(part);
        bundles.push({ name: `regions ${i + 1}-${i + part.length}`, elements: part.flatMap((r) => r.elements) });
      }
      const chosen = await ask(bundles);
      level = chosen.flatMap((b) => members[bundles.indexOf(b)] ?? []);
    }
    const [first, second] = (await ask(level)) as [Region, Region | undefined];
    if (second !== undefined) {
      const union = new Set([...first.elements, ...second.elements]);
      if (union.size <= budget) return [...union];
    }
    return first.elements;
  }

  let current = ordered;
  while (current.length > budget) {
    const next = byRank(await pick(group(current, budget, options.viewportHeight)));
    // Guarantee progress: a pick that did not shrink the set is redone over equal chunks.
    current = next.length < current.length ? next : byRank(await pick(chunk(current, budget, 'page')));
  }
  return { candidates: current, trail };
}
