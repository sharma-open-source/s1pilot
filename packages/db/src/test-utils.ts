import { newId, type Project } from '@s1pilot/domain';

import { openDb, type Db, type SecretCrypto } from './db.js';
import { repos } from './repos/index.js';

/** Reversible non-identity stub so tests can prove plaintext never reaches the database. */
export const stubCrypto: SecretCrypto = {
  encrypt: (plaintext) => `enc:${Buffer.from(plaintext).toString('base64')}`,
  decrypt: (ciphertext) => Buffer.from(ciphertext.slice('enc:'.length), 'base64').toString(),
};

/** Fresh in-memory database with all migrations applied. */
export function memoryDb(): Db {
  return openDb({ url: ':memory:', crypto: stubCrypto });
}

/** Creates a project with the given key. */
export function makeProject(db: Db, key = 'SHOP'): Promise<Project> {
  return repos.projects.create(db, { id: newId(), name: `Project ${key}`, key });
}

/** Minimal valid new-case input. */
export function caseInput(title = 'A case') {
  return {
    title,
    priority: 'P2' as const,
    type: 'e2e' as const,
    status: 'draft' as const,
    steps: [{ action: 'Open the home page', expected: 'Home page is shown' }],
  };
}
