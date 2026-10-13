import { describe, expect, it } from 'vitest';

import { unwrapFrame, wrapFrame } from './protocol.js';
import { RegisterWorkerSchema, WorkerRegistry } from './registry.js';

describe('WorkerRegistry', () => {
  it('tracks labels, jobs, heartbeats and goes offline without them', () => {
    const clock = { t: 1_000_000 };
    const reg = new WorkerRegistry(30_000, () => clock.t);
    reg.register(RegisterWorkerSchema.parse({ labels: ['gpu'], version: '1.0.0', concurrency: 2, name: 'box' }), 'w1');
    expect(reg.labelsOf('w1')).toEqual(['gpu']);
    expect(reg.list()).toMatchObject([{ id: 'w1', name: 'box', status: 'idle', jobs: [] }]);

    reg.assign('w1', 'j1', 'r1');
    expect(reg.list()[0]).toMatchObject({ status: 'busy', jobs: [{ jobId: 'j1', runId: 'r1' }] });

    clock.t += 31_000;
    expect(reg.list()[0]?.status).toBe('offline');
    expect(reg.heartbeat('w1')).toBe(true);
    expect(reg.list()[0]?.status).toBe('busy');
    reg.releaseJob('j1');
    expect(reg.list()[0]?.status).toBe('idle');
    expect(reg.heartbeat('nope')).toBe(false);
  });

  it('keeps registration time and jobs across a re-registration, and forgets workers offline for a day', () => {
    const clock = { t: 0 };
    const reg = new WorkerRegistry(1000, () => clock.t);
    reg.register(RegisterWorkerSchema.parse({}), 'w1');
    reg.assign('w1', 'j1');
    clock.t = 500;
    reg.register(RegisterWorkerSchema.parse({ labels: ['eu'] }), 'w1');
    expect(reg.list()[0]).toMatchObject({ labels: ['eu'], registeredAt: new Date(0).toISOString(), jobs: [{ jobId: 'j1' }] });
    clock.t += 25 * 3_600_000;
    expect(reg.list()).toEqual([]);
  });

  it('validates registration input', () => {
    expect(RegisterWorkerSchema.safeParse({ labels: ['bad label'] }).success).toBe(false);
    expect(RegisterWorkerSchema.safeParse({ concurrency: 0 }).success).toBe(false);
    expect(RegisterWorkerSchema.parse({})).toMatchObject({ labels: [], concurrency: 1, version: 'unknown' });
  });
});

describe('frame wrapping', () => {
  it('round-trips the run id and the frame bytes', () => {
    const frame = Buffer.from([1, 2, 3, 4]);
    expect(unwrapFrame(wrapFrame('run-1', frame))).toEqual({ runId: 'run-1', frame });
    expect(() => unwrapFrame(Buffer.from([9, 1]))).toThrow();
  });
});
