import type { Context } from '../trpc/context.js';

import type { AuditInput } from './audit.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** What an audited mutation looked like (a bare string input such as an id arrives as `{ id }`); `before` is whatever the rule's loader returned before the call ran. */
interface Call {
  input: Obj;
  result: Obj;
  before: unknown;
}

/** How a mutation is written to the audit log. `after` defaults to the procedure result. */
interface AuditRule {
  /** Loads the state before the mutation runs (for the before/after diff). */
  before?: (ctx: Context, input: Obj) => Promise<unknown>;
  describe: (call: Call) => Omit<AuditInput, 'before' | 'after'> & { after?: unknown };
  /** Take `after` from the input rather than the result (results that carry secrets). */
  afterFromInput?: boolean;
}

const caseByKey = (ctx: Context, input: Obj): Promise<unknown> => ctx.repos.cases.getByKey(ctx.db, str(input['key']));
const planById = (ctx: Context, input: Obj): Promise<unknown> => ctx.repos.plans.get(ctx.db, str(input['id']));
const projectKeyOf = (input: Obj): string | undefined => (typeof input['projectKey'] === 'string' ? input['projectKey'] : undefined);

/**
 * Audited tRPC mutations, by procedure path (S-067). Covers case edits, plan edits, approvals, overrides, heal
 * decisions, secret reveals, settings changes and sign-offs. Written after the mutation succeeded.
 */
export const AUDIT_RULES: Readonly<Record<string, AuditRule>> = {
  // Case edits
  'cases.create': { describe: ({ result, input }) => ({ action: 'case.create', entityType: 'case', entityId: str(result['key']), projectKey: projectKeyOf(input) }) },
  'cases.update': {
    before: caseByKey,
    describe: ({ input }) => ({ action: 'case.update', entityType: 'case', entityId: str(input['key']) }),
  },
  'cases.updateFromYaml': {
    before: caseByKey,
    describe: ({ input }) => ({ action: 'case.update', entityType: 'case', entityId: str(input['key']) }),
  },
  'cases.bulk': {
    afterFromInput: true,
    describe: ({ input, result }) => ({
      action: `case.bulk.${str(input['action'])}`,
      entityType: 'case',
      entityId: Array.isArray(result['keys']) ? result['keys'].join(',') : '',
      after: { ...input, ids: undefined, keys: result['keys'] },
    }),
  },
  'cases.quarantine': { afterFromInput: true, describe: ({ input }) => ({ action: 'case.quarantine', entityType: 'case', entityId: str(input['key']) }) },
  'cases.unquarantine': { afterFromInput: true, describe: ({ input }) => ({ action: 'case.unquarantine', entityType: 'case', entityId: str(input['key']) }) },
  // Plan edits
  'plans.create': { describe: ({ result, input }) => ({ action: 'plan.create', entityType: 'plan', entityId: str(result['id']), projectKey: projectKeyOf(input) }) },
  'plans.update': { before: planById, describe: ({ input }) => ({ action: 'plan.update', entityType: 'plan', entityId: str(input['id']) }) },
  'plans.delete': {
    before: planById,
    describe: ({ input }) => ({ action: 'plan.delete', entityType: 'plan', entityId: str(input['id']), after: null }),
  },
  'triggers.update': { afterFromInput: true, describe: ({ input }) => ({ action: 'plan.trigger', entityType: 'plan', entityId: str(input['planId'] ?? input['id']) }) },
  'triggers.regenerateToken': { afterFromInput: true, describe: ({ input }) => ({ action: 'plan.trigger.token', entityType: 'plan', entityId: str(input['id']) }) },
  // Approvals, heal decisions, overrides
  'reviews.decide': {
    before: (ctx, input) => ctx.repos.reviews.get(ctx.db, str(input['id'])),
    afterFromInput: true,
    describe: ({ input, before }) => {
      const kind = str(obj(before)['kind']);
      return {
        action: kind === 'heal' ? 'heal.decide' : 'review.decide',
        entityType: kind === 'heal' ? 'heal-proposal' : 'review-item',
        entityId: str(obj(before)['refId'] ?? input['id']),
        after: { decision: input['decision'], verdict: input['verdict'], note: input['note'], reviewItem: input['id'] },
      };
    },
  },
  'results.overrideVerdict': {
    before: async (ctx, input) => {
      const r = await ctx.repos.results.getCase(ctx.db, str(input['resultId']));
      return r ? { verdict: r.verdict } : undefined;
    },
    afterFromInput: true,
    describe: ({ input }) => ({
      action: 'verdict.override',
      entityType: 'case-result',
      entityId: str(input['resultId']),
      after: { verdict: input['verdict'], note: input['note'] },
    }),
  },
  'runs.signOff': { describe: ({ input }) => ({ action: 'run.signoff', entityType: 'run', entityId: str(input['runId']) }) },
  'runs.control': {
    describe: ({ input }) => ({ action: 'run.control', entityType: 'run', entityId: str(input['runId']), after: { control: obj(input['message'])['type'] } }),
  },
  // Secrets: key name only, never the value
  'environments.revealSecret': {
    describe: ({ input }) => ({ action: 'secret.reveal', entityType: 'environment', entityId: str(input['envId']), after: { key: input['key'] } }),
  },
  // Settings
  'models.updateSettings': {
    before: async (ctx, input) =>
      input['target'] === 'workspace'
        ? ctx.repos.settings.get(ctx.db, 'workspace.modelSettings')
        : (await ctx.repos.projects.getByKey(ctx.db, str(input['target'])))?.modelSettings,
    afterFromInput: true,
    describe: ({ input }) => ({ action: 'settings.models', entityType: 'settings', entityId: str(input['target']), after: input['settings'] }),
  },
  'workspace.update': {
    before: async (ctx) => ({
      name: await ctx.repos.settings.get(ctx.db, 'workspace.name'),
      timezone: await ctx.repos.settings.get(ctx.db, 'workspace.timezone'),
      retentionDays: await ctx.repos.settings.get(ctx.db, 'workspace.retentionDays'),
    }),
    describe: ({ result }) => ({ action: 'settings.workspace', entityType: 'settings', entityId: 'workspace', after: { name: result['name'], timezone: result['timezone'], retentionDays: result['retentionDays'] } }),
  },
  'workspace.purge': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.purge', entityType: 'project', entityId: str(input['projectKey']) }) },
  'notifications.channels.save': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.notifications', entityType: 'settings', entityId: 'channel', after: { id: input['id'], name: input['name'] } }) },
  'notifications.channels.delete': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.notifications', entityType: 'settings', entityId: 'channel', after: { deleted: input['id'] } }) },
  'notifications.rules.save': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.notifications', entityType: 'settings', entityId: 'rule', after: { id: input['id'], name: input['name'] } }) },
  'notifications.rules.delete': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.notifications', entityType: 'settings', entityId: 'rule', after: { deleted: input['id'] } }) },
  'tokens.create': { afterFromInput: true, describe: ({ input, result }) => ({ action: 'settings.token.create', entityType: 'api-token', entityId: str(obj(result['record'])['id']), after: { name: input['name'], scopes: input['scopes'] } }) },
  'tokens.revoke': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.token.revoke', entityType: 'api-token', entityId: str(input['id']) }) },
  'trackers.connect': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.trackers', entityType: 'settings', entityId: str(input['provider']), after: { connected: input['provider'] } }) },
  'trackers.disconnect': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.trackers', entityType: 'settings', entityId: str(input['id']), after: { disconnected: input['id'] } }) },
  'trackers.setMapping': { afterFromInput: true, describe: ({ input }) => ({ action: 'settings.trackers', entityType: 'settings', entityId: 'mapping', projectKey: projectKeyOf(input) }) },
  'projects.create': { describe: ({ result }) => ({ action: 'project.create', entityType: 'project', entityId: str(result['key']) }) },
  'projects.update': { afterFromInput: true, describe: ({ input }) => ({ action: 'project.update', entityType: 'project', entityId: str(input['key']), after: input['patch'] ?? input }) },
  'projects.delete': { afterFromInput: true, describe: ({ input }) => ({ action: 'project.delete', entityType: 'project', entityId: str(input['key']) }) },
  'environments.create': { describe: ({ result }) => ({ action: 'environment.create', entityType: 'environment', entityId: str(result['id']) }) },
  'environments.update': {
    before: (ctx, input) => ctx.repos.environments.get(ctx.db, str(input['id'])),
    describe: ({ input }) => ({ action: 'environment.update', entityType: 'environment', entityId: str(input['id']) }),
  },
  'environments.delete': { afterFromInput: true, describe: ({ input }) => ({ action: 'environment.delete', entityType: 'environment', entityId: str(input['id']) }) },
};
