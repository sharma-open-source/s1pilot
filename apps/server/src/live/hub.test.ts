import { createVault, openDb, repos } from '@s1pilot/db';
import { newId, type RunEvent } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { RunEventBus } from '../worker/event-bus.js';

import { LiveHub, type RunSnapshot } from './hub.js';

describe('LiveHub snapshot', () => {
  it('lists every running case with its own steps, so a late joiner sees all parallel browsers', async () => {
    const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
    const project = await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    const run = await repos.runs.create(db, { id: newId(), projectId: project.id, trigger: 'manual', status: 'running' });
    const bus = new RunEventBus();
    const hub = new LiveHub({ db, bus });
    const base = { runId: run.id, ts: '2026-10-13T10:00:00.000Z' };
    const events: RunEvent[] = [
      { ...base, type: 'case.started', caseResultId: 'a', caseId: 'ca', caseKey: 'SHOP-TC-1' },
      { ...base, type: 'case.started', caseResultId: 'b', caseId: 'cb', caseKey: 'SHOP-TC-2' },
      { ...base, type: 'case.started', caseResultId: 'c', caseId: 'cc', caseKey: 'SHOP-TC-3' },
      { ...base, type: 'step.started', caseResultId: 'a', stepIndex: 0, action: 'Open shop' },
      { ...base, type: 'step.started', caseResultId: 'b', stepIndex: 0, action: 'Search' },
      { ...base, type: 'case.finished', caseResultId: 'c', verdict: 'passed', durationMs: 5 },
    ];
    for (const e of events) bus.emit(e);

    const texts: string[] = [];
    await hub.subscribeRun(run.id, { sendText: (t) => texts.push(t), sendBinary: () => undefined });
    const snap = JSON.parse(texts[0] as string) as RunSnapshot;
    expect(snap.lanes).toEqual([
      { caseResultId: 'a', caseId: 'ca', caseKey: 'SHOP-TC-1', steps: [{ stepIndex: 0, action: 'Open shop', status: 'running' }] },
      { caseResultId: 'b', caseId: 'cb', caseKey: 'SHOP-TC-2', steps: [{ stepIndex: 0, action: 'Search', status: 'running' }] },
    ]);
    hub.close();
    db.close();
  });
});
