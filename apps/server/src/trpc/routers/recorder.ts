import { IdSchema, ProjectKeySchema, S1PilotError } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireCase, requireEnvironment, requireProject, requireSuiteIn } from './helpers.js';

const SessionInput = z.object({ sessionId: IdSchema });

function requireWriter(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot record tests');
}

/** Browser recorder (S-060): start a headed recording, watch the captured steps, stop, review, save. */
export const recorderRouter = router({
  /**
   * Opens a browser window on the server machine (local mode) at the environment's base URL. With `caseKey` the
   * recorded steps are inserted into that case at `fromStep` (default: the end); otherwise a draft case is created.
   */
  start: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        environmentId: IdSchema.optional(),
        caseKey: z.string().min(1).optional(),
        fromStep: z.number().int().min(0).optional(),
        suiteId: IdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const project = await requireProject(ctx, input.projectKey);
      const envId = input.environmentId ?? project.defaultEnvironmentId;
      if (!envId) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Project ${project.key} has no environment`);
      const environment = await requireEnvironment(ctx, envId);
      if (environment.projectId !== project.id) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found in project: ${envId}`, { id: envId });
      const testCase = input.caseKey ? await requireCase(ctx, input.caseKey) : undefined;
      if (testCase && testCase.projectId !== project.id) throw new S1PilotError('CASE_NOT_FOUND', `Case not found in project: ${input.caseKey}`);
      if (input.suiteId) await requireSuiteIn(ctx, input.suiteId, project.id);
      return ctx.runtime.recorder.start({
        project,
        environment,
        ...(testCase ? { testCase } : {}),
        ...(input.fromStep !== undefined ? { fromStep: input.fromStep } : {}),
        ...(input.suiteId ? { suiteId: input.suiteId } : {}),
      });
    }),

  /** Live captured steps (poll while recording); includes the draft once stopped. */
  status: publicProcedure.input(SessionInput).query(({ ctx, input }) => ctx.runtime.recorder.status(input.sessionId)),

  pause: publicProcedure.input(SessionInput).mutation(({ ctx, input }) => ctx.runtime.recorder.pause(input.sessionId)),

  resume: publicProcedure.input(SessionInput).mutation(({ ctx, input }) => ctx.runtime.recorder.resume(input.sessionId)),

  /** "Add expected result": closes the current step and attaches the text to it. */
  addExpectation: publicProcedure
    .input(SessionInput.extend({ text: z.string().trim().min(1).max(500) }))
    .mutation(({ ctx, input }) => ctx.runtime.recorder.addExpectation(input.sessionId, input.text)),

  /** Stops recording, closes the browser and returns the draft (steps, variable proposals) for review. */
  stop: publicProcedure.input(SessionInput).mutation(({ ctx, input }) => ctx.runtime.recorder.stop(input.sessionId)),

  /**
   * Saves the reviewed steps: creates variables, appends the steps to the case (or creates a draft case) and stores the
   * learned script. Secret values typed into the review dialog are stored encrypted like any environment secret.
   */
  save: publicProcedure
    .input(
      SessionInput.extend({
        steps: z.array(z.object({ id: z.string().min(1).optional(), action: z.string().trim().min(1), expected: z.string().trim().optional() })).min(1),
        variables: z.record(z.string()).optional(),
        title: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const { sessionId, ...rest } = input;
      return ctx.runtime.recorder.save(sessionId, rest);
    }),

  /** Drops the recording and closes the browser. */
  cancel: publicProcedure.input(SessionInput).mutation(async ({ ctx, input }) => {
    await ctx.runtime.recorder.cancel(input.sessionId);
    return { cancelled: true as const };
  }),
});
