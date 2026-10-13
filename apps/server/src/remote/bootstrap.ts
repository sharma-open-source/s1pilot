import { repos, type Db } from '@s1pilot/db';
import { S1PilotError, newId } from '@s1pilot/domain';

import { TOKEN_RE, hashToken } from '../auth/tokens.js';

/** Name of the token {@link ensureWorkerToken} creates. */
export const BOOTSTRAP_TOKEN_NAME = 'remote workers (S1PILOT_WORKER_TOKEN)';

/**
 * Makes the token from `S1PILOT_WORKER_TOKEN` usable by remote workers (scope `runs:write`) so a compose stack can
 * start the server and its workers together with one shared secret. Idempotent: an existing token with the same
 * prefix is left alone (a revoked one stays revoked). Only the hash is stored.
 * @throws S1PilotError `CONFIG_ERROR` when the value is not shaped like an s1pilot token (`s1p_<8 hex>_<48 hex>`).
 */
export async function ensureWorkerToken(db: Db, token: string): Promise<void> {
  const m = TOKEN_RE.exec(token);
  if (!m) throw new S1PilotError('CONFIG_ERROR', 'S1PILOT_WORKER_TOKEN must look like s1p_<8 hex>_<48 hex>, e.g. generated with: echo "s1p_$(openssl rand -hex 4)_$(openssl rand -hex 24)"');
  const prefix = `s1p_${m[1]}`;
  if (await repos.apiTokens.getByPrefix(db, prefix)) return;
  await repos.apiTokens.create(db, {
    id: newId(),
    name: BOOTSTRAP_TOKEN_NAME,
    prefix,
    hash: await hashToken(token),
    scopes: ['runs:write'],
    createdBy: 'bootstrap',
    createdAt: new Date().toISOString(),
  });
}
