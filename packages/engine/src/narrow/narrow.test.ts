import type { Question } from '@s1pilot/domain';
import { fallbacks, MockDecisionModel } from '@s1pilot/providers';
import { describe, expect, it } from 'vitest';

import type { ObservedElement } from '../observer/types.js';

import { narrow, NARROW_META_ACTIONS } from './narrow.js';

function el(i: number, name: string, landmark: string | undefined, y: number, role = 'link'): ObservedElement {
  return {
    id: `e${i}`,
    role,
    name,
    state: {},
    ...(landmark === undefined ? {} : { landmark }),
    box: { x: 0, y, w: 100, h: 20 },
    locators: [],
  };
}

/** A generated page of `n` filler links in `landmarks` landmarks plus named target controls. */
function page(n: number, landmarks: (string | undefined)[], targets: Record<string, string | undefined> = {}) {
  const elements: ObservedElement[] = [];
  for (let i = 0; i < n; i++) {
    elements.push(el(elements.length + 1, `Item ${i} zzz${i}`, landmarks[i % landmarks.length], 10 + i * 8));
  }
  for (const [name, landmark] of Object.entries(targets)) {
    elements.push(el(elements.length + 1, name, landmark, 10 + elements.length * 8, 'button'));
  }
  return { elements };
}

function maxOptionsSeen(model: MockDecisionModel): number {
  return Math.max(
    0,
    ...model.calls.flatMap((c) => Object.values(c.request.questions).map((q) => (q.type === 'choice' ? Object.keys(q.criteria).length : 0))),
  );
}

describe('narrow', () => {
  it('returns everything (relevance ordered) when elements plus meta actions fit', async () => {
    const model = new MockDecisionModel();
    const obs = page(5, ['main'], { 'Add to cart': 'main' });
    const { candidates, trail } = await narrow(obs, { maxOptions: 20 }, model, 'Add the item to the cart');
    expect(candidates).toHaveLength(6);
    expect(candidates[0]?.name).toBe('Add to cart');
    expect(trail).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it('boundary: exactly maxOptions - meta elements is not narrowed', async () => {
    const model = new MockDecisionModel();
    const n = 20 - NARROW_META_ACTIONS.length;
    const { candidates } = await narrow(page(n, ['main']), { maxOptions: 20 }, model, 'x');
    expect(candidates).toHaveLength(n);
    expect(model.calls).toHaveLength(0);
  });

  it('keeps every model call within maxOptions on a 120-element page and finds the target', async () => {
    const landmarks = ['nav:Main', 'main', 'form:Search', 'region:Footer', 'dialog:Cookies', 'nav:Side'];
    const model = new MockDecisionModel({ fallback: fallbacks.byLabelIncludes('Checkout') });
    const obs = page(119, landmarks, { Checkout: 'main' });
    const { candidates, trail } = await narrow(obs, { maxOptions: 20 }, model, 'Click the Checkout button');
    expect(obs.elements).toHaveLength(120);
    expect(model.calls.length).toBeGreaterThan(0);
    expect(maxOptionsSeen(model)).toBeLessThanOrEqual(20);
    expect(candidates.length).toBeLessThanOrEqual(20 - NARROW_META_ACTIONS.length);
    expect(candidates.map((c) => c.name)).toContain('Checkout');
    expect(candidates[0]?.name).toBe('Checkout');
    expect(trail).toHaveLength(model.calls.length);
    expect(trail[0]).toMatchObject({ questionId: 'narrow-region-1', model: 'system1' });
    expect(trail[0]?.optionLabels?.r1).toMatch(/\(\d+ elements\): /);
    expect(trail[0]?.options.length).toBeGreaterThan(1);
  });

  it('asks the documented question with counts and sample labels', async () => {
    const model = new MockDecisionModel({ fallback: fallbacks.byLabelIncludes('Pay') });
    await narrow(page(60, ['nav', 'main'], { 'Pay now': 'main' }), { maxOptions: 20 }, model, 'Pay now');
    const q = model.calls[0]?.request.questions['narrow-region-1'];
    expect(q?.type).toBe('choice');
    expect(q?.instructions).toBe('Which region most likely contains the control for: Pay now?');
    const first = q?.type === 'choice' ? Object.values(q.criteria)[0] : '';
    expect(first).toMatch(/^main \(\d+ elements\): Pay now/);
  });

  it('falls back to vertical bands when there are no landmarks', async () => {
    const model = new MockDecisionModel({ fallback: fallbacks.byLabelIncludes('Subscribe') });
    const { candidates } = await narrow(page(100, [undefined], { Subscribe: undefined }), { maxOptions: 20 }, model, 'Subscribe');
    expect(maxOptionsSeen(model)).toBeLessThanOrEqual(20);
    expect(candidates.map((c) => c.name)).toContain('Subscribe');
    const q = model.calls[0]?.request.questions['narrow-region-1'];
    expect(q?.type === 'choice' && Object.values(q.criteria)[0]).toMatch(/band/);
  });

  it('splits a single oversized region into chunks and bundles when regions exceed maxOptions', async () => {
    const model = new MockDecisionModel({ fallback: fallbacks.byLabelIncludes('Needle') });
    const many = Array.from({ length: 40 }, (_, i) => `nav:L${i}`);
    const obs = page(150, many, { Needle: 'nav:L7' });
    const { candidates } = await narrow(obs, { maxOptions: 8 }, model, 'Needle');
    expect(maxOptionsSeen(model)).toBeLessThanOrEqual(8);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates.map((c) => c.name)).toContain('Needle');
  });

  it('keeps the runner-up region when confidence is low and the union fits', async () => {
    const lowConfidence = (q: Question) => {
      const ids = q.type === 'choice' ? Object.keys(q.criteria) : [];
      const probabilities = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.4 : i === 1 ? 0.35 : 0.25 / Math.max(1, ids.length - 2)]));
      return { choice: ids[0] as string, probabilities, confidence: 0.4 };
    };
    // Two 12-element regions: union 24 > budget 15, so only the top region survives.
    const wide = await narrow(page(24, ['nav', 'main']), { maxOptions: 20 }, new MockDecisionModel({ fallback: lowConfidence }), 'x');
    expect(wide.candidates).toHaveLength(12);
    expect(wide.trail).toHaveLength(1);

    // Four 3-element regions: top two merge to 6 <= 15, but 12 elements already fit, so no call at all.
    // Use maxOptions 9 (budget 4): 12 elements, four regions of 3, union of two is 6 > 4 -> top only.
    // Use maxOptions 11 (budget 6): union of two regions (6) fits.
    const merged = await narrow(page(12, ['a', 'b', 'c', 'd']), { maxOptions: 11 }, new MockDecisionModel({ fallback: lowConfidence }), 'x');
    expect(merged.candidates).toHaveLength(6);
    expect(merged.trail[0]?.confidence).toBe(0.4);
  });

  it('does not merge when the top region is confident', async () => {
    const confident = (q: Question) => ({ choice: q.type === 'choice' ? (Object.keys(q.criteria)[0] as string) : '', confidence: 0.9 });
    const { candidates } = await narrow(page(12, ['a', 'b', 'c', 'd']), { maxOptions: 11 }, new MockDecisionModel({ fallback: confident }), 'x');
    expect(candidates).toHaveLength(3);
  });

  it('finds the target for every step of a shop-like page', async () => {
    const landmarks = ['nav:Main', 'main', 'region:Footer'];
    const steps: [string, string][] = [
      ['Click Add to cart', 'Add to cart'],
      ['Open the Basket', 'Basket'],
      ['Press Checkout', 'Checkout'],
      ['Enter promo code', 'Promo code'],
      ['Choose Express shipping', 'Express shipping'],
    ];
    const targets = Object.fromEntries(steps.map(([, t], i) => [t, landmarks[i % 3]]));
    const obs = page(130, landmarks, targets);
    for (const [step, target] of steps) {
      const model = new MockDecisionModel({ fallback: fallbacks.byLabelIncludes(target) });
      const { candidates } = await narrow(obs, { maxOptions: 20 }, model, step);
      expect(maxOptionsSeen(model)).toBeLessThanOrEqual(20);
      expect(candidates.map((c) => c.name)).toContain(target);
    }
  });
});

describe('narrow: wrong region picks', () => {
  it('keeps the best lexical matches even when the model picks the wrong region', async () => {
    // The labelled slider sits near the top; unnamed media sliders hinted "video volume" sit at the bottom.
    const elements: ObservedElement[] = [];
    elements.push({ ...el(1, 'Volume: 50%', undefined, 10, 'slider') });
    for (let i = 0; i < 120; i++) elements.push(el(elements.length + 1, `Item ${i} zzz${i}`, undefined, 30 + i * 8));
    elements.push({ ...el(elements.length + 1, '', undefined, 2000, 'slider'), idHint: 'video volume' });
    elements.push({ ...el(elements.length + 1, '', undefined, 2010, 'slider'), idHint: 'audio volume' });
    // A model that always picks the region whose samples mention "video".
    const model = new MockDecisionModel({
      fallback: (q: Question) =>
        q.type === 'choice'
          ? { choice: (Object.entries(q.criteria).find(([, d]) => d.includes('video')) ?? Object.entries(q.criteria)[0])?.[0] as string, confidence: 0.9 }
          : { noul: 0.5 },
    });
    const { candidates, trail } = await narrow({ elements }, { maxOptions: 20 }, model, 'Set the volume slider to "90"');
    expect(trail.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.name)).toContain('Volume: 50%');
    expect(candidates.length).toBeLessThanOrEqual(20 - NARROW_META_ACTIONS.length);
    // Own words rank above hints: the labelled slider comes first.
    expect(candidates[0]?.name).toBe('Volume: 50%');
  });
});
