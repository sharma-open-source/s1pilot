import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ProfileSchema, S1PilotError, type Profile } from '@s1pilot/domain';

/** Directory of `profiles/*.json`; override with `S1PILOT_PROFILES_DIR`. */
function profilesDir(dir?: string): string {
  // From both src/ and dist/ the repo root is three levels up.
  return dir ?? process.env['S1PILOT_PROFILES_DIR'] ?? fileURLToPath(new URL('../../../profiles/', import.meta.url));
}

/** Loads and validates one capability profile (`clef`, `clef-flash`, `jev`, `jev-9b`, `laya`, …). */
export function loadProfile(id: string, dir?: string): Profile {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new S1PilotError('PROFILE_NOT_FOUND', `Invalid profile id: ${id}`, { id });
  }
  let raw: string;
  try {
    raw = readFileSync(`${profilesDir(dir)}/${id}.json`, 'utf8');
  } catch {
    throw new S1PilotError('PROFILE_NOT_FOUND', `Unknown model profile: ${id}`, { id });
  }
  return ProfileSchema.parse(JSON.parse(raw));
}

/** All available profiles, sorted by id. */
export function listProfiles(dir?: string): Profile[] {
  return readdirSync(profilesDir(dir))
    .filter((file) => file.endsWith('.json'))
    .map((file) => loadProfile(file.slice(0, -'.json'.length), dir))
    .sort((a, b) => a.id.localeCompare(b.id));
}
