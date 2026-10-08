import {
  HealProposalSchema,
  S1PilotError,
  newId,
  type HealProposal,
  type LearnedScript,
  type ResolvedAction,
  type ReviewStatus,
  type TestCase,
} from '@s1pilot/domain';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { z } from 'zod';

import { atomic, type Db } from '../db.js';
import { healProposals as t, learnedScripts as scriptsTable, reviewItems } from '../schema/index.js';

import { cases } from './cases.js';
import { learnedScripts } from './learned-scripts.js';
import { projects } from './projects.js';
import { sharedSteps } from './shared-steps.js';
import { fromRow, notFound, nowIso } from './util.js';

export type HealProposalInput = z.input<typeof HealProposalSchema>;

/** Which learned scripts an approved proposal updates. */
export type HealApplyScope = 'all' | 'case';

/** Filters for `healProposals.list`. */
export interface HealProposalFilter {
  caseId?: string;
  environmentId?: string;
  runId?: string;
  status?: ReviewStatus;
}

/** True when the case inlines the shared step (flow) in its steps or preconditions. */
function usesSharedStep(testCase: TestCase, id: string, name: string | undefined): boolean {
  return (
    testCase.steps.some((s) => s.sharedStepId === id || (name !== undefined && s.sharedStepId === name)) ||
    testCase.preconditions.some((p) => 'flow' in p && (p.flow === id || p.flow === name))
  );
}

const byPosition = (a: ResolvedAction, b: ResolvedAction): number => a.stepIndex - b.stepIndex || a.subIndex - b.subIndex;

/**
 * Replaces the actions of one step with `after`. The step is found by index, or by the hash of its
 * text (cases that inline the same shared step at another position). Returns `undefined` when no
 * action matches.
 */
function replaceStep(
  script: LearnedScript,
  target: { stepIndex: number } | { stepHash: string },
  after: readonly ResolvedAction[],
): LearnedScript | undefined {
  const hit = (a: ResolvedAction): boolean => ('stepHash' in target ? a.stepHash === target.stepHash : a.stepIndex === target.stepIndex);
  const indices = [...new Set(script.actions.filter(hit).map((a) => a.stepIndex))];
  if (indices.length === 0) return undefined;
  const replaced = script.actions.filter((a) => !hit(a));
  for (const stepIndex of indices) {
    after.forEach((a, subIndex) => replaced.push({ ...a, stepIndex, subIndex }));
  }
  return { ...script, actions: replaced.sort(byPosition) };
}

async function bumpPending(db: Db, caseId: string, environmentId: string, delta: number): Promise<void> {
  const script = await learnedScripts.getFor(db, caseId, environmentId);
  if (!script) return;
  const pendingProposals = Math.max(0, script.health.pendingProposals + delta);
  db.orm.update(scriptsTable).set({ health: { ...script.health, pendingProposals } }).where(eq(scriptsTable.id, script.id)).run();
}

function assertPending(proposal: HealProposal): void {
  if (proposal.status !== 'pending') {
    throw new S1PilotError('INVALID_STATE', `Heal proposal ${proposal.id} is already ${proposal.status}`, {
      id: proposal.id,
      status: proposal.status,
    });
  }
}

/** Heal proposals (plan section 2.3). Approving updates the learned scripts; rejecting changes nothing. */
export const healProposals = {
  /**
   * Stores a proposal as `pending` and queues a review item. `impactCaseIds` always contains the
   * proposal's case and, for a shared step, every case of the project that uses it. With the
   * project setting `autoApplyHeals` the proposal is applied to its own case's script right away
   * (and returned as `approved`).
   */
  async create(db: Db, input: HealProposalInput): Promise<HealProposal> {
    const parsed = HealProposalSchema.parse({ ...input, status: 'pending' });
    const testCase = await cases.get(db, parsed.caseId);
    if (!testCase) return notFound('TestCase', parsed.caseId);
    const impact = new Set([parsed.caseId, ...parsed.impactCaseIds]);
    if (parsed.sharedStepId) {
      const shared = await sharedSteps.get(db, parsed.sharedStepId);
      for (const c of await cases.list(db, { projectId: testCase.projectId })) {
        if (usesSharedStep(c, parsed.sharedStepId, shared?.name)) impact.add(c.id);
      }
    }
    const createdAt = parsed.createdAt ?? nowIso();
    const proposal = { ...parsed, impactCaseIds: [...impact], createdAt };
    atomic(db, () => {
      db.orm.insert(t).values(proposal).run();
      db.orm
        .insert(reviewItems)
        .values({ id: newId(), projectId: testCase.projectId, kind: 'heal', refId: proposal.id, status: 'pending', createdAt })
        .run();
    });
    await bumpPending(db, proposal.caseId, proposal.environmentId, 1);
    const project = await projects.get(db, testCase.projectId);
    if (project?.autoApplyHeals) return this.approve(db, proposal.id, { scope: 'case' });
    return (await this.get(db, proposal.id)) as HealProposal;
  },

  async get(db: Db, id: string): Promise<HealProposal | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(HealProposalSchema, row);
  },

  async list(db: Db, filter: HealProposalFilter = {}): Promise<HealProposal[]> {
    const conditions: SQL[] = [];
    if (filter.caseId) conditions.push(eq(t.caseId, filter.caseId));
    if (filter.environmentId) conditions.push(eq(t.environmentId, filter.environmentId));
    if (filter.runId) conditions.push(eq(t.runId, filter.runId));
    if (filter.status) conditions.push(eq(t.status, filter.status));
    return db.orm
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.createdAt))
      .all()
      .map((row) => fromRow(HealProposalSchema, row));
  },

  /**
   * Applies a pending proposal to learned scripts and marks it `approved`. `scope` `all` (default)
   * updates the proposal's case and every impacted case (matched by the hash of the step text, as
   * the step can sit at another index there); `case` only the proposal's own case.
   */
  async approve(db: Db, id: string, opts: { scope?: HealApplyScope; userId?: string } = {}): Promise<HealProposal> {
    const proposal = await this.get(db, id);
    if (!proposal) return notFound('HealProposal', id);
    assertPending(proposal);
    const scope = opts.scope ?? 'all';
    const hash = proposal.before.find((a) => a.stepHash)?.stepHash ?? proposal.after.find((a) => a.stepHash)?.stepHash;
    const ts = nowIso();
    const targets = scope === 'all' ? [...new Set([proposal.caseId, ...proposal.impactCaseIds])] : [proposal.caseId];
    const updates: LearnedScript[] = [];
    for (const caseId of targets) {
      const script = await learnedScripts.getFor(db, caseId, proposal.environmentId);
      if (!script) continue;
      const target = caseId === proposal.caseId ? { stepIndex: proposal.stepIndex } : hash ? { stepHash: hash } : undefined;
      const next = target && replaceStep(script, target, proposal.after);
      if (next) updates.push({ ...next, health: { ...next.health, healCount: next.health.healCount + 1, lastHealedAt: ts } });
    }
    atomic(db, () => {
      for (const s of updates) {
        db.orm.update(scriptsTable).set({ actions: s.actions, health: s.health }).where(eq(scriptsTable.id, s.id)).run();
      }
      db.orm
        .update(t)
        .set({ status: 'approved', ...(opts.userId ? { approvedLive: opts.userId } : {}) })
        .where(eq(t.id, id))
        .run();
      db.orm.update(reviewItems).set({ status: 'approved', resolvedAt: ts }).where(eq(reviewItems.refId, id)).run();
    });
    await bumpPending(db, proposal.caseId, proposal.environmentId, -1);
    return (await this.get(db, id)) as HealProposal;
  },

  /** Marks a pending proposal `rejected`; learned scripts stay as they are. */
  async reject(db: Db, id: string): Promise<HealProposal> {
    const proposal = await this.get(db, id);
    if (!proposal) return notFound('HealProposal', id);
    assertPending(proposal);
    atomic(db, () => {
      db.orm.update(t).set({ status: 'rejected' }).where(eq(t.id, id)).run();
      db.orm.update(reviewItems).set({ status: 'rejected', resolvedAt: nowIso() }).where(eq(reviewItems.refId, id)).run();
    });
    await bumpPending(db, proposal.caseId, proposal.environmentId, -1);
    return (await this.get(db, id)) as HealProposal;
  },
};
export type HealProposalsRepo = typeof healProposals;
