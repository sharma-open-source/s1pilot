import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LearnedScriptSchema, type LearnedScript } from '@s1pilot/domain';

/** Identifies the (case, environment) a learned script belongs to. */
export interface LearnedScriptRef {
  caseKey: string;
  caseId: string;
  environmentName: string;
  environmentId: string;
}

/** Persistence of learned scripts. FS in CLI mode; the DB implementation lives in `@s1pilot/db`. */
export interface LearnedScriptStore {
  get(ref: LearnedScriptRef): Promise<LearnedScript | undefined>;
  put(ref: LearnedScriptRef, script: LearnedScript): Promise<void>;
  delete(ref: LearnedScriptRef): Promise<void>;
}

const safe = (s: string): string => s.replace(/[^\w.-]+/g, '_');

/** Stores `<root>/.s1pilot/learned/<caseKey>/<env>.json`. */
export class FsLearnedScriptStore implements LearnedScriptStore {
  constructor(private readonly projectRoot: string) {}

  /** Path of the script file for a reference. */
  pathFor(ref: Pick<LearnedScriptRef, 'caseKey' | 'environmentName'>): string {
    return join(this.projectRoot, '.s1pilot', 'learned', safe(ref.caseKey), `${safe(ref.environmentName)}.json`);
  }

  async get(ref: LearnedScriptRef): Promise<LearnedScript | undefined> {
    const path = this.pathFor(ref);
    if (!existsSync(path)) return undefined;
    // Files are keyed by environment *name*; environment ids are minted per load from YAML, so the
    // script is re-bound to the current environment id (otherwise replay never finds its script).
    return { ...LearnedScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8'))), environmentId: ref.environmentId };
  }

  async put(ref: LearnedScriptRef, script: LearnedScript): Promise<void> {
    const path = this.pathFor(ref);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(LearnedScriptSchema.parse(script), null, 2)}\n`);
  }

  async delete(ref: LearnedScriptRef): Promise<void> {
    await rm(this.pathFor(ref), { force: true });
  }
}
