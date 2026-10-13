import type { RunEvent, TestCase } from '@s1pilot/domain';
import type { RunnerEvent } from '@s1pilot/runner';

/**
 * Maps a runner progress event to the run event published on the bus, or undefined for events with another path
 * (`case.finished` is persisted first, `run.*` belong to the lifecycle). Shared by in-process and remote workers.
 */
export function toRunEvent(event: RunnerEvent, ctx: { runId: string; caseId: TestCase['id']; now?: () => string }): RunEvent | undefined {
  const { runId } = ctx;
  const ts = (ctx.now ?? (() => new Date().toISOString()))();
  switch (event.type) {
    case 'engine':
      // The runner's own `step.finished` (below) is authoritative: it follows verification and covers replay.
      if (event.event.type === 'step.finished') return undefined;
      return { ...event.event, runId } as RunEvent;
    case 'case.started':
      return { type: 'case.started', runId, ts, caseResultId: event.caseResultId, caseId: ctx.caseId, caseKey: event.key, mode: event.mode };
    case 'note':
      return { type: 'log', runId, ts, level: 'info', message: event.text };
    case 'step.finished':
      return {
        type: 'step.finished',
        runId,
        ts,
        caseResultId: event.caseResultId,
        stepIndex: event.step.index,
        status: ['passed', 'failed', 'blocked', 'skipped'].includes(event.step.verdict) ? (event.step.verdict as 'passed') : 'blocked',
        durationMs: event.step.durationMs,
      };
    default:
      return undefined;
  }
}
