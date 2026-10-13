import {
  CalibrationModelSchema,
  CaseRunResultSchema,
  EnvironmentSchema,
  HealProposalSchema,
  LearnedScriptSchema,
  ModelSettingsSchema,
  SharedStepSchema,
  TestCaseSchema,
  TestDataSetSchema,
} from '@s1pilot/domain';
import { z } from 'zod';

/** Everything a remote worker needs to run one `run-case` job without database access. */
export const JobContextSchema = z.object({
  testCase: TestCaseSchema,
  environment: EnvironmentSchema,
  project: z.object({ id: z.string(), key: z.string(), redactPatterns: z.array(z.string()) }),
  modelSettings: ModelSettingsSchema,
  /** Decrypted inline secret variables of the environment by key. They exist only in the worker's memory. */
  secrets: z.record(z.string()),
  /** API keys decrypted from `secret:model/…` references of `modelSettings`. They exist only in the worker's memory. */
  modelSecrets: z.object({ s1: z.string().optional(), s2: z.string().optional() }).default({}),
  flows: z.array(SharedStepSchema),
  /** Test data set rows usable in this environment, by set name (S-026). */
  datasets: z.record(TestDataSetSchema.shape.rows).default({}),
  /** Fitted calibration models of the project (S-058). */
  calibration: z.array(CalibrationModelSchema),
});
export type JobContext = z.infer<typeof JobContextSchema>;

/** Response of `POST /api/workers/:id/claim` when a job was leased. */
export interface ClaimedJob {
  job: { id: string; runId?: string; attempts: number; payload: unknown };
  context: JobContext;
  /** Lease the worker must keep alive with heartbeats, in ms. */
  leaseMs: number;
}

/** Body of `POST /api/workers/:id/heartbeat`. */
export const HeartbeatSchema = z.object({ jobs: z.array(z.string()).max(256).default([]) });

/** Response of the heartbeat: jobs the worker no longer owns (lease expired, run cancelled) and must abandon. */
export interface HeartbeatResult {
  ok: true;
  lost: string[];
}

export const FailJobSchema = z.object({ error: z.string().max(4000), retry: z.boolean().default(false) });

export const CaseResultBodySchema = z.object({ attempt: z.number().int().min(1), result: CaseRunResultSchema });
export const CaseDoneBodySchema = z.object({ caseResultId: z.string(), attempt: z.number().int().min(1) });

export const ScriptGetSchema = z.object({ caseId: z.string(), environmentId: z.string() });
export const ScriptPutSchema = z.object({ script: LearnedScriptSchema });
export const HealProposalDraftSchema = HealProposalSchema.omit({ status: true, createdAt: true });

/** Messages worker -> server on `/ws/workers/:id` (text); screencast frames go as binary. */
export type WorkerMessage = { type: 'event'; jobId: string; event: unknown };

/** Messages server -> worker on `/ws/workers/:id`. */
export type ServerMessage =
  /** Sent once the socket is authenticated; the worker holds its messages until then. */
  | { type: 'ready' }
  /** Subscribers of a run changed: stream frames while above zero. */
  | { type: 'demand'; runId: string; subscribers: number }
  /** Abandon the jobs of a run now (it was cancelled). */
  | { type: 'abort'; runId: string };

/**
 * Binary frame worker -> server: `[runIdLen u8][runId utf8][encodeFrame(...)]` (see `live/frame.ts`).
 */
export function wrapFrame(runId: string, frame: Buffer): Buffer {
  const id = Buffer.from(runId, 'utf8');
  return Buffer.concat([Buffer.from([id.length]), id, frame]);
}

/** Inverse of {@link wrapFrame}. */
export function unwrapFrame(buf: Buffer): { runId: string; frame: Buffer } {
  const len = buf.readUInt8(0);
  if (buf.length < 1 + len) throw new RangeError('frame too short');
  return { runId: buf.subarray(1, 1 + len).toString('utf8'), frame: buf.subarray(1 + len) };
}
