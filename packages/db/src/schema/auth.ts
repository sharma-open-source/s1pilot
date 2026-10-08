import type { AuthValidation } from '@s1pilot/domain';
import { sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

import { environments } from './core.js';

/** Saved logins per environment. The storage state is stored only as vault ciphertext. */
export const authSetups = sqliteTable(
  'auth_setups',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['recorded', 'flow'] }).notNull(),
    flowId: text('flow_id'),
    /** Vault-encrypted Playwright storage state (JSON); never plaintext. */
    stateCiphertext: text('state_ciphertext'),
    lastRefreshedAt: text('last_refreshed_at'),
    status: text('status', { enum: ['valid', 'expired', 'never'] }).notNull(),
    validation: text('validation', { mode: 'json' }).$type<AuthValidation>(),
  },
  (t) => [unique('auth_setups_env_name_unq').on(t.environmentId, t.name)],
);
