import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId, type AuditEntry, type LocatorCandidate, type ResolvedAction, type Role } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import { auditCsv } from '../trpc/routers/audit.js';

import { auditDiff, redactForAudit } from './audit.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
afterEach(() => dbs.splice(0).forEach((d) => d.close()));

const GUEST: LocatorCandidate = { kind: 'role', value: 'button', name: 'Guest checkout' };
const RENAMED: LocatorCandidate = { kind: 'role', value: 'button', name: 'Checkout as guest' };
const action = (stepIndex: number, locator: LocatorCandidate): ResolvedAction => ({
  stepIndex, subIndex: 0, action: 'click', locators: [locator], fingerprint: 'fp', stepHash: 'h', fromRunId: 'r1',
});

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const config = loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot', logLevel: 'silent' }, {});
  const log = createLogger({ level: 'silent' });
  const as = (role: Role, id = `${role}-1`) => makeCaller(createContext({ db, config, log, user: { id, role, name: `${role} user` }, request: { ip: '10.0.0.7' } }));
  const admin = as('admin');
  const project = await admin.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const env = await admin.environments.create({
    projectKey: 'SHOP', name: 'staging', baseUrl: 'https://staging.test',
    variables: [{ key: 'PASSWORD', value: 'hunter2-plaintext', secret: true }],
  });
  const flow = await repos.sharedSteps.create(db, { id: newId(), projectId: project.id, name: 'guest', params: [], steps: [{ action: 'Guest' }] });
  const c = await admin.cases.create({ projectKey: 'SHOP', title: 'Guest A', steps: [{ action: 'Prepare' }, { action: 'Guest', sharedStepId: flow.id }] });
  await repos.learnedScripts.upsert(db, { id: newId(), caseId: c.id, caseVersion: 1, environmentId: env.id, createdFromRunId: 'r1', actions: [action(1, GUEST)] });
  await repos.healProposals.create(db, {
    id: newId(), caseId: c.id, environmentId: env.id, runId: 'r2', stepIndex: 1, sharedStepId: flow.id,
    before: [action(1, GUEST)], after: [action(1, RENAMED)], confidence: 0.6, s2Agreed: true,
  });
  await repos.runs.create(db, { id: 'run1', projectId: project.id, trigger: 'manual', status: 'needs-review', summary: { passed: 0, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 1 } });
  await repos.results.createCase(db, { id: 'cr1', runId: 'run1', caseId: c.id, caseVersion: 1, environmentId: env.id, verdict: 'needs-review', durationMs: 5, mode: 'explore', browser: 'chromium' });
  await repos.results.addStep(db, {
    id: 'cr1-0', caseResultId: 'cr1', stepIndex: 0, status: 'passed',
    decisions: [{ questionId: 'q', options: ['yes', 'no'], probabilities: { yes: 0.55, no: 0.45 }, confidence: 0.55, model: 'm', latencyMs: 3 }],
    assertions: [{ assertion: 'ai', verdict: 'needs-review', probability: 0.55 }],
  });
  await repos.reviews.create(db, { id: 'rv1', projectId: project.id, kind: 'verdict', refId: 'cr1', status: 'pending' });
  await repos.runs.create(db, { id: 'run2', projectId: project.id, trigger: 'manual', status: 'passed', summary: { passed: 1, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 } });
  const entries = async (action: string): Promise<AuditEntry[]> => (await admin.audit.list({ action, limit: 200 })).entries;
  return { admin, as, db, env, c, entries };
}

describe('audit log entries (S-067)', () => {
  it('case edits: create, update (diff only), bulk, quarantine', async () => {
    const { as, c, entries } = await setup();
    const tester = as('tester');
    await tester.cases.update({ key: c.key, expectedVersion: 1, patch: { title: 'Guest B' } });
    const [update] = await entries('case.update');
    expect(update).toMatchObject({ actorId: 'tester-1', entityType: 'case', entityId: c.key, ip: '10.0.0.7' });
    expect(update?.actorName).toBe('tester user');
    expect(update?.before).toMatchObject({ title: 'Guest A' });
    expect(update?.after).toMatchObject({ title: 'Guest B' });
    expect(JSON.stringify(update?.after)).not.toContain('Prepare'); // unchanged steps are not part of the diff
    expect((await entries('case.create'))[0]).toMatchObject({ entityId: c.key, projectKey: 'SHOP' });
    await tester.cases.bulk({ ids: [c.id], action: 'tag', add: ['smoke'], remove: [] });
    expect(await entries('case.bulk.tag')).toHaveLength(1);
    await tester.cases.quarantine({ key: c.key, reason: 'flaky' });
    expect(await entries('case.quarantine')).toHaveLength(1);
  });

  it('plan edits: create, update, delete', async () => {
    const { admin, as, env, entries } = await setup();
    const lead = as('lead');
    const plan = await lead.plans.create({ projectKey: 'SHOP', name: 'Smoke', selection: { kind: 'list', caseIds: [] }, matrix: [{ environmentId: env.id, browser: 'chromium' }] });
    await lead.plans.update({ id: plan.id, patch: { retries: 2 } });
    await lead.plans.delete(plan.id);
    expect(await entries('plan.create')).toHaveLength(1);
    const [update] = await entries('plan.update');
    expect(update?.before).toMatchObject({ retries: 0 });
    expect(update?.after).toMatchObject({ retries: 2 });
    const [del] = await entries('plan.delete');
    expect(del).toMatchObject({ entityId: plan.id, after: null });
    expect(del?.before).toMatchObject({ name: 'Smoke' });
    expect((await admin.audit.list({ action: 'plan.*' })).entries).toHaveLength(3);
  });

  it('heal decisions and review approvals', async () => {
    const { as, entries } = await setup();
    const lead = as('lead');
    const heal = (await lead.reviews.list({ projectKey: 'SHOP', tab: 'heals' })).items[0];
    await lead.reviews.decide({ id: heal?.id as string, decision: 'approve', note: 'rename' });
    expect(await entries('heal.decide')).toHaveLength(1);
    expect((await entries('heal.decide'))[0]?.after).toMatchObject({ decision: 'approve', note: 'rename' });
    await as('tester').reviews.decide({ id: 'rv1', decision: 'approve', note: '' });
    expect(await entries('review.decide')).toHaveLength(1);
  });

  it('a tester cannot approve a heal proposal (leads and admins only)', async () => {
    const { as } = await setup();
    const tester = as('tester');
    const heal = (await tester.reviews.list({ projectKey: 'SHOP', tab: 'heals' })).items[0];
    await expect(tester.reviews.decide({ id: heal?.id as string, decision: 'approve', note: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(tester.reviews.decide({ id: heal?.id as string, decision: 'reject', note: '' })).resolves.toBeDefined();
  });

  it('verdict overrides', async () => {
    const { as, entries } = await setup();
    await as('tester').results.overrideVerdict({ resultId: 'cr1', verdict: 'failed', note: 'Wrong' });
    const [entry] = await entries('verdict.override');
    expect(entry).toMatchObject({ entityType: 'case-result', entityId: 'cr1' });
    expect(entry?.before).toMatchObject({ verdict: 'needs-review' });
    expect(entry?.after).toMatchObject({ verdict: 'failed', note: 'Wrong' });
  });

  it('secret reveals log the key, never the value', async () => {
    const { admin, as, env, entries } = await setup();
    await as('lead').environments.revealSecret({ envId: env.id, key: 'PASSWORD' });
    const [entry] = await entries('secret.reveal');
    expect(entry).toMatchObject({ entityType: 'environment', entityId: env.id, after: { key: 'PASSWORD' } });
    expect(JSON.stringify(await admin.audit.list({ limit: 200 }))).not.toContain('hunter2');
    await expect(as('tester').environments.revealSecret({ envId: env.id, key: 'PASSWORD' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('settings changes: models, workspace, tokens', async () => {
    const { admin, entries } = await setup();
    await admin.models.updateSettings({
      target: 'workspace',
      settings: { system1: { adapter: 'mock', model: 'mock', apiKeyRef: 'env:SECRET_KEY' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
    });
    expect(await entries('settings.models')).toHaveLength(1);
    expect(JSON.stringify(await entries('settings.models'))).not.toContain('SECRET_KEY'); // key refs are redacted too
    await admin.workspace.update({ name: 'Acme QA' });
    expect((await entries('settings.workspace'))[0]?.after).toMatchObject({ name: 'Acme QA' });
    const { token } = await admin.tokens.create({ name: 'CI', scopes: ['runs:write'] });
    expect(await entries('settings.token.create')).toHaveLength(1);
    expect(JSON.stringify(await admin.audit.list({ limit: 200 }))).not.toContain(token);
  });

  it('sign-offs', async () => {
    const { as, entries } = await setup();
    await as('lead').runs.signOff({ runId: 'run2', note: 'Ship it' });
    const [entry] = await entries('run.signoff');
    expect(entry).toMatchObject({ entityType: 'run', entityId: 'run2', actorId: 'lead-1' });
    expect(entry?.after).toMatchObject({ by: 'lead-1', note: 'Ship it' });
  });

  it('failed mutations write nothing', async () => {
    const { as, entries } = await setup();
    await expect(as('tester').cases.update({ key: 'SHOP-TC-999', expectedVersion: 1, patch: { title: 'x' } })).rejects.toBeDefined();
    expect(await entries('case.update')).toEqual([]);
  });
});

describe('audit helpers', () => {
  it('redacts secrets and cuts long values', () => {
    const out = redactForAudit({ apiKey: 'k', password: 'p', nested: { token: 't', ok: 1 }, variables: [{ key: 'A', type: 'secret', value: 'v' }], big: 'x'.repeat(2000) }) as Record<string, unknown>;
    expect(out['apiKey']).toBe('[redacted]');
    expect(out['password']).toBe('[redacted]');
    expect(out['nested']).toEqual({ token: '[redacted]', ok: 1 });
    expect(out['variables']).toEqual([{ key: 'A', type: 'secret', value: '[redacted]' }]);
    expect((out['big'] as string).length).toBeLessThan(600);
  });

  it('diffs only changed fields, recursively', () => {
    expect(auditDiff({ a: 1, b: { c: 1, d: 2 }, e: [1] }, { a: 1, b: { c: 2, d: 2 }, e: [1, 2] })).toEqual({ before: { b: { c: 1 }, e: [1] }, after: { b: { c: 2 }, e: [1, 2] } });
    expect(auditDiff(undefined, { a: 1 })).toEqual({ before: null, after: { a: 1 } });
  });

  it('exports CSV with formula injection neutralised', () => {
    const csv = auditCsv([{ id: '1', at: '2026-01-01T00:00:00.000Z', actorId: 'u', actorName: '=cmd|calc', action: 'case.update', entityType: 'case', entityId: 'X', projectKey: null, before: null, after: { a: '"q"' }, ip: null }]);
    expect(csv.split('\r\n')[0]).toBe('time,actor,actor_id,action,entity_type,entity_id,project,ip,before,after');
    expect(csv).toContain(`"'=cmd|calc"`);
    expect(csv).toContain('{""a"":""\\""q\\""""}');
  });
});
