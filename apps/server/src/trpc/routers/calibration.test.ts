import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId, type ReviewOutcome } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCalibrator } from '../../calibration/service.js';
import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

import { outcomeFor } from './verdicts.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
});

/** Unwraps a value the test expects to exist. */
function def<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const config = loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot', logLevel: 'silent' }, {});
  const api = makeCaller(createContext({ db, config, log: createLogger({ level: 'silent' }) }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  await repos.projects.update(db, project.id, {
    modelSettings: {
      system1: { adapter: 'mock', model: 'clef' },
      thresholds: { act: 0.9, pass: 0.8, fail: 0.2, escalate: 0.5 },
      dualOrderSensitive: false,
    },
  });
  const review = async (pTrue: number, humanVerdict: 'passed' | 'failed') => {
    const outcome: ReviewOutcome = { pTrue, humanVerdict, questionType: 'noul', optionCount: 2, model: 'clef' };
    await repos.reviews.create(db, {
      id: newId(),
      projectId: project.id,
      kind: 'verdict',
      refId: newId(),
      status: humanVerdict === 'passed' ? 'approved' : 'rejected',
      outcome,
    });
  };
  return { api, db, project, review };
}

/** Over-confident model: right 70% of the time at p = 0.9, plus a perfectly reliable 0.99 band. */
async function seedOverconfident(review: (p: number, v: 'passed' | 'failed') => Promise<void>) {
  for (let i = 0; i < 100; i++) await review(0.9, i < 70 ? 'passed' : 'failed');
  for (let i = 0; i < 40; i++) await review(0.99, 'passed');
}

describe('calibration router', () => {
  it('reports an unfitted project and refuses to apply without a suggestion', async () => {
    const { api } = await setup();
    const s = await api.calibration.status({ projectKey: 'SHOP' });
    expect(s).toMatchObject({ fitted: false, models: [], reviewedSamples: 0, suggestion: null, lastTunedAt: null });
    await expect(api.calibration.applyThresholds({ projectKey: 'SHOP' })).rejects.toThrow(/suggestion/);
  });

  it('fits T > 1 on over-confident reviews, lowers the ECE and stores the model for later runs', async () => {
    const { api, db, project, review } = await setup();
    await seedOverconfident(review);
    const fitted = await api.calibration.fit({ projectKey: 'SHOP' });
    const model = def(fitted.models.find((m) => m.key === 'clef|noul|2'));
    expect(model.T).toBeGreaterThan(1);
    expect(model.n).toBe(140);
    expect(def(fitted.eceAfter)).toBeLessThan(def(fitted.eceBefore));
    expect(fitted.reliabilityBefore).toHaveLength(10);
    expect(fitted.reliabilityAfter).toHaveLength(10);

    // The calibrator workers load for the project uses the stored temperature.
    const calibrator = await loadCalibrator(db, project.id);
    expect(calibrator.calibrate('clef', 'noul', { true: 0.9, false: 0.1 })['true']).toBeLessThan(0.9);

    // Analytics shows the calibrated ECE next to the raw one.
    const ai = await api.analytics.aiQuality({ projectKey: 'SHOP', range: 30 });
    expect(ai.eceCalibrated).not.toBeNull();
    expect(ai.ece).not.toBeNull();
  });

  it('suggests thresholds but never applies them until confirmed', async () => {
    const { api, db, project, review } = await setup();
    await seedOverconfident(review);
    const fitted = await api.calibration.fit({ projectKey: 'SHOP' });
    const suggestion = def(fitted.suggestion);
    expect(suggestion.falsePassRate).toBeLessThanOrEqual(0.01);

    const thresholdsOf = async () => def(def(await repos.projects.get(db, project.id)).modelSettings).thresholds;
    const before = await thresholdsOf();
    expect(before).toMatchObject({ pass: 0.8, fail: 0.2 });
    expect(fitted.lastTunedAt).toBeNull();
    // Fitting again still leaves the thresholds alone.
    await api.calibration.fit({ projectKey: 'SHOP' });
    expect(await thresholdsOf()).toEqual(before);

    const applied = await api.calibration.applyThresholds({ projectKey: 'SHOP' });
    const after = await thresholdsOf();
    expect(after.pass).toBe(suggestion.pass);
    expect(after.fail).toBe(suggestion.fail);
    expect(after.act).toBe(0.9);
    expect(applied.lastTunedAt).not.toBeNull();
  });

  it('keeps T = 1 below 50 samples per bucket', async () => {
    const { api, review } = await setup();
    for (let i = 0; i < 30; i++) await review(0.9, i < 20 ? 'passed' : 'failed');
    const fitted = await api.calibration.fit({ projectKey: 'SHOP' });
    expect(fitted.models).toEqual([]);
    expect(fitted.suggestion).toBeNull();
  });
});

describe('outcomeFor', () => {
  it('records the raw P(true) when the decision was calibrated', () => {
    const outcome = outcomeFor(
      [
        {
          stepIndex: 0,
          assertions: [{ assertion: 'ai', verdict: 'needs-review', probability: 0.75 }],
          decisions: [
            {
              questionId: 'expected_true',
              options: ['true', 'false'],
              probabilities: { true: 0.75, false: 0.25 },
              confidence: 0.75,
              raw: { probabilities: { true: 0.9, false: 0.1 }, confidence: 0.9 },
              model: 'clef',
              latencyMs: 1,
            },
          ],
        },
      ] as never,
      'passed',
      'local',
    );
    expect(outcome?.pTrue).toBe(0.9);
  });
});
