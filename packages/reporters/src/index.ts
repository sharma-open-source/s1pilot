import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunReport } from '@s1pilot/domain';

import { renderJson } from './json.js';
import { renderJunit, type JunitOptions } from './junit.js';

export { parseRunReport, renderJson } from './json.js';
export { escapeXml, renderJunit, type JunitOptions } from './junit.js';
export { parseXml, validateJunit, type XmlElement } from './validate-junit.js';

/** Reporter names accepted by `--reporter`. */
export const REPORTER_NAMES = ['junit', 'json'] as const;
export type ReporterName = (typeof REPORTER_NAMES)[number];

/** File name each reporter writes below the output directory. */
export const REPORTER_FILES: Record<ReporterName, string> = { junit: 'junit.xml', json: 'report.json' };

/** Parses a comma-separated `--reporter` value; throws on unknown names. */
export function parseReporterList(value: string): ReporterName[] {
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = names.find((n) => !(REPORTER_NAMES as readonly string[]).includes(n));
  if (bad !== undefined) throw new Error(`Unknown reporter "${bad}"; available: ${REPORTER_NAMES.join(', ')}`);
  return [...new Set(names)] as ReporterName[];
}

/** Writes the chosen reports into `dir` and returns the file paths. */
export async function writeReports(
  report: RunReport,
  dir: string,
  names: readonly ReporterName[],
  junit: JunitOptions = {},
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const name of names) {
    const path = join(dir, REPORTER_FILES[name]);
    await writeFile(path, name === 'junit' ? renderJunit(report, junit) : renderJson(report));
    written.push(path);
  }
  return written;
}
