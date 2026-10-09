import { Calibrator, ModelSettingsSchema, ProjectKeySchema, S1PilotError, type CalibrationState } from '@s1pilot/domain';
import { z } from 'zod';

import { calibrationKeyFor, collectSamples, evaluate, fitProject, loadCalibrationState } from '../../calibration/service.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { effectiveModelSettings, requireProject } from './helpers.js';

const Input = z.object({ projectKey: ProjectKeySchema });

async function status(ctx: Context, projectKey: string, state?: CalibrationState) {
  const project = await requireProject(ctx, projectKey);
  const stored = state ?? (await loadCalibrationState(ctx.db, project.id));
  const calibrator = new Calibrator(stored?.models ?? []);
  const samples = await collectSamples(ctx.db, project.id);
  const settings = await effectiveModelSettings(ctx, project);
  return {
    fitted: stored !== undefined,
    fittedAt: stored?.fittedAt ?? null,
    lastTunedAt: stored?.lastTunedAt ?? null,
    reviewedSamples: samples.length,
    models: stored?.models ?? [],
    /** Reliability diagram data (10 bins) and ECE of the reviewed data, raw and calibrated. */
    ...evaluate(samples, calibrator),
    /** Shown to the user; applied only through `applyThresholds`. */
    suggestion: stored?.suggestion ?? null,
    thresholds: settings ? { pass: settings.thresholds.pass, fail: settings.thresholds.fail } : null,
  };
}

/** Calibration of System 1 probabilities from human review outcomes (S-058). */
export const calibrationRouter = router({
  /** Current calibration models, ECE before/after, reliability bins and the threshold suggestion. */
  status: publicProcedure.input(Input).query(({ ctx, input }) => status(ctx, input.projectKey)),

  /** Refits the temperatures from the reviewed data and stores them; subsequent runs use them. */
  fit: publicProcedure.input(Input).mutation(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const settings = await effectiveModelSettings(ctx, project);
    const state = await fitProject(ctx.db, project.id, settings?.thresholds ?? { pass: 0.8, fail: 0.2 });
    return status(ctx, input.projectKey, state);
  }),

  /** The user's explicit confirmation of the stored suggestion: writes `pass`/`fail` into the project's model settings. */
  applyThresholds: publicProcedure.input(Input).mutation(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const state = await loadCalibrationState(ctx.db, project.id);
    if (!state?.suggestion) {
      throw new S1PilotError('NO_SUGGESTION', 'There is no threshold suggestion to apply; fit the calibration first');
    }
    const settings = await effectiveModelSettings(ctx, project);
    if (!settings) throw new S1PilotError('MODEL_NOT_CONFIGURED', 'No System 1 model is configured (Settings → Models).');
    const next = ModelSettingsSchema.parse({
      ...settings,
      thresholds: { ...settings.thresholds, pass: state.suggestion.pass, fail: state.suggestion.fail },
    });
    await ctx.repos.projects.update(ctx.db, project.id, { modelSettings: next });
    await ctx.repos.settings.set(ctx.db, calibrationKeyFor(project.id), { ...state, lastTunedAt: new Date().toISOString() });
    return status(ctx, input.projectKey);
  }),
});
