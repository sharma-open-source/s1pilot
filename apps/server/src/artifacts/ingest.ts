import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

import { repos, type Db } from '@s1pilot/db';
import { newId, type CaseRunResult } from '@s1pilot/domain';

import type { ArtifactStore } from './store.js';

/**
 * Moves the files a runner wrote for one case instance (`<workDir>/<result.dir>`) into the artifact store and links
 * them as evidence: step screenshots to their step result, case-level files (video, trace, logs) to the last step
 * result (evidence rows hang off steps). Call after the case and its steps are persisted. Returns the artifact count.
 */
export async function ingestCaseArtifacts(opts: {
  db: Db;
  store: ArtifactStore;
  projectId: string;
  workDir: string;
  result: CaseRunResult;
}): Promise<number> {
  const { db, store, projectId, workDir, result } = opts;
  const dir = join(workDir, result.dir);
  const steps = await repos.results.listSteps(db, result.caseResultId);
  const byIndex = new Map(steps.map((s) => [s.stepIndex, s]));
  const last = steps[steps.length - 1];
  let count = 0;

  const add = async (
    file: string,
    kind: Parameters<typeof repos.artifacts.linkEvidence>[1]['kind'],
    contentType: string,
    stepIndex: number | undefined,
    stepResultId: string | undefined,
  ): Promise<void> => {
    const path = join(dir, file);
    if (!existsSync(path)) return;
    const artifactId = await store.put(createReadStream(path), {
      projectId,
      runId: result.runId,
      caseResultId: result.caseResultId,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      kind,
      name: file,
      contentType,
    });
    count++;
    if (stepResultId)
      await repos.artifacts.linkEvidence(db, { id: newId(), stepResultId, kind, artifactId });
  };

  for (const step of result.steps) {
    if (step.screenshot)
      await add(
        step.screenshot,
        'screenshot',
        'image/png',
        step.index,
        byIndex.get(step.index)?.id,
      );
  }
  for (const f of result.files ?? []) await add(f.file, f.kind, f.contentType, undefined, last?.id);
  return count;
}
