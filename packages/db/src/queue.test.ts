import { describe, expect, it } from 'vitest';

import { createSqliteJobQueue } from './queue.js';
import { memoryDb } from './test-utils.js';

function setup() {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const queue = createSqliteJobQueue(memoryDb(), () => new Date(clock.t));
  return { queue, clock };
}

describe('sqlite job queue', () => {
  it('claims in FIFO order, once, and completes', async () => {
    const { queue, clock } = setup();
    const a = await queue.enqueue({ type: 'run-case', payload: { n: 1 } });
    clock.t += 1;
    await queue.enqueue({ type: 'run-case', payload: { n: 2 } });
    const claimed = await queue.claim('w1');
    expect(claimed).toMatchObject({ id: a.id, status: 'running', attempts: 1, workerId: 'w1' });
    expect((await queue.claim('w2'))?.payload).toEqual({ n: 2 });
    expect(await queue.claim('w3')).toBeUndefined();
    expect(await queue.complete(a.id, 'w2')).toBe(false);
    expect(await queue.complete(a.id, 'w1', { ok: true })).toBe(true);
    expect(await queue.get(a.id)).toMatchObject({ status: 'completed', result: { ok: true } });
  });

  it('filters by type', async () => {
    const { queue } = setup();
    await queue.enqueue({ type: 'other', payload: {} });
    expect(await queue.claim('w', { types: ['run-case'] })).toBeUndefined();
  });

  it('re-queues a job whose lease expired once, then fails it', async () => {
    const { queue, clock } = setup();
    const job = await queue.enqueue({ type: 'run-case', payload: {} });
    await queue.claim('dead', { leaseMs: 1000 });
    clock.t += 500;
    expect(await queue.claim('w2')).toBeUndefined();
    clock.t += 1000;
    const retried = await queue.claim('w2', { leaseMs: 1000 });
    expect(retried).toMatchObject({ id: job.id, attempts: 2, workerId: 'w2' });
    // The dead worker lost the job.
    expect(await queue.heartbeat(job.id, 'dead')).toBe(false);
    expect(await queue.heartbeat(job.id, 'w2', 5000)).toBe(true);
    clock.t += 10_000;
    expect(await queue.claim('w3')).toBeUndefined();
    expect(await queue.get(job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('lease expired') });
  });

  it('fail() retries only when asked and attempts remain', async () => {
    const { queue } = setup();
    const job = await queue.enqueue({ type: 't', payload: {}, maxAttempts: 2 });
    await queue.claim('w');
    expect(await queue.fail(job.id, 'w', 'boom', { retry: true })).toBe(true);
    expect((await queue.get(job.id))?.status).toBe('queued');
    await queue.claim('w');
    await queue.fail(job.id, 'w', 'boom again', { retry: true });
    expect(await queue.get(job.id)).toMatchObject({ status: 'failed', error: 'boom again' });
  });

  it('cancels queued and running jobs of a run', async () => {
    const { queue } = setup();
    const a = await queue.enqueue({ type: 't', runId: 'r1', payload: {} });
    const b = await queue.enqueue({ type: 't', runId: 'r1', payload: {} });
    const other = await queue.enqueue({ type: 't', runId: 'r2', payload: {} });
    await queue.claim('w');
    const affected = await queue.cancelByRun('r1');
    expect(affected.map((j) => j.status).sort()).toEqual(['queued', 'running']);
    expect((await queue.listByRun('r1')).map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
    expect(await queue.heartbeat(a.id, 'w')).toBe(false);
    expect(await queue.cancel(b.id)).toBe(false);
    expect((await queue.claim('w'))?.id).toBe(other.id);
  });
});
