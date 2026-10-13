import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { ROLES, can, type Role } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { permissionFor } from '../trpc/authz.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

import { SESSION_COOKIE, ROTATE_AFTER_MS, ROTATE_GRACE_MS, createSession, resolveSession } from './sessions.js';
import { signInAs } from './testing.js';

const makeCaller = createCallerFactory(appRouter);
const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function teamApp(extra: Parameters<typeof loadConfig>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's1pilot-team-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir: join(dir, '.s1pilot'), mode: 'team', logLevel: 'silent', workers: 0, ...extra }, {});
  const app = await buildApp(config, { db, workers: 0, dev: false, scheduler: false, trackerSync: false, webDist: join(dir, 'none') });
  closers.push(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, db, config };
}

/** Minimal client for the tRPC HTTP API (no transformer: bodies are plain JSON). */
function client(app: FastifyInstance, cookieRef: { cookie?: string } = {}) {
  const call = async (method: 'GET' | 'POST', path: string, input?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url: method === 'GET' && input !== undefined ? `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}` : `/trpc/${path}`,
      headers: { ...(cookieRef.cookie ? { cookie: cookieRef.cookie } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(method === 'POST' ? { payload: JSON.stringify(input ?? null) } : {}),
    });
    const set = res.headers['set-cookie'];
    const cookies = (Array.isArray(set) ? set : set ? [set] : []) as string[];
    const fresh = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
    if (fresh) cookieRef.cookie = fresh.split(';')[0] as string;
    const body = res.body ? (JSON.parse(res.body) as { result?: { data: unknown }; error?: { message: string; data: { code: string; httpStatus: number } } }) : {};
    return { status: res.statusCode, data: body.result?.data as never, error: body.error, cookies };
  };
  return {
    query: (path: string, input?: unknown, headers?: Record<string, string>) => call('GET', path, input, headers),
    mutate: (path: string, input?: unknown, headers?: Record<string, string>) => call('POST', path, input, headers),
    cookieRef,
  };
}

const ADMIN = { email: 'ann@example.com', name: 'Ann Admin', password: 'correct horse battery' };

describe('permission matrix', () => {
  it('has four roles with the documented capabilities', () => {
    expect(ROLES).toEqual(['admin', 'lead', 'tester', 'viewer']);
    expect(can('viewer', 'read')).toBe(true);
    expect(can('viewer', 'content:write')).toBe(false);
    expect(can('tester', 'content:write') && can('tester', 'runs:execute') && can('tester', 'reviews:decide')).toBe(true);
    expect(can('tester', 'plans:write') || can('tester', 'signoff') || can('tester', 'settings:manage')).toBe(false);
    expect(can('lead', 'plans:write') && can('lead', 'signoff') && can('lead', 'approvals:decide')).toBe(true);
    expect(can('lead', 'settings:manage') || can('lead', 'users:manage')).toBe(false);
    expect(ROLES.every((r) => can('admin', 'users:manage') && can('admin', 'settings:manage') && (r === 'admin' || !can(r, 'users:manage')))).toBe(true);
  });

  it('maps procedures to permissions', () => {
    expect(permissionFor('projects.list', 'query')).toBe('read');
    expect(permissionFor('cases.update', 'mutation')).toBe('content:write');
    expect(permissionFor('plans.create', 'mutation')).toBe('plans:write');
    expect(permissionFor('runs.create', 'mutation')).toBe('runs:execute');
    expect(permissionFor('runs.signOff', 'mutation')).toBe('signoff');
    expect(permissionFor('models.updateSettings', 'mutation')).toBe('settings:manage');
    expect(permissionFor('users.list', 'query')).toBe('users:manage');
    expect(permissionFor('audit.list', 'query')).toBe('audit:read');
    expect(permissionFor('tokens.list', 'query')).toBe('settings:manage');
  });
});

describe('RBAC on tRPC procedures', () => {
  it('a viewer gets 403 on every mutation procedure and an anonymous caller gets 401 on everything non-public', async () => {
    const { db, config } = await teamApp();
    const log = createLogger({ level: 'silent' });
    const viewer = makeCaller(createContext({ db, config, log, user: { id: 'v', role: 'viewer' } })) as unknown as Record<string, unknown>;
    const anon = makeCaller(createContext({ db, config, log })) as unknown as Record<string, unknown>;
    const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
    const mutations = Object.entries(procedures).filter(([path, p]) => p._def.type === 'mutation' && !path.startsWith('session.'));
    expect(mutations.length).toBeGreaterThan(60);
    const at = (root: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root) as (input?: unknown) => Promise<unknown>;
    for (const [path] of mutations) {
      await expect(at(viewer, path)({}), `viewer ${path}`).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(at(anon, path)({}), `anonymous ${path}`).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    // Viewers can read.
    await expect((viewer['projects'] as { list: () => Promise<unknown> }).list()).resolves.toEqual([]);
    await expect((anon['projects'] as { list: () => Promise<unknown> }).list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('roles can only use what the matrix gives them', async () => {
    const { db, config } = await teamApp();
    const log = createLogger({ level: 'silent' });
    const as = (role: Role) => makeCaller(createContext({ db, config, log, user: { id: role, role } }));
    await expect(as('tester').users.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as('lead').users.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as('lead').tokens.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as('lead').audit.list({})).resolves.toMatchObject({ entries: [] });
    await expect(as('tester').audit.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as('tester').workspace.update({ name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as('admin').users.list()).resolves.toMatchObject({ users: [] });
    await expect(as('tester').plans.delete('nope')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as('tester').runs.signOff({ runId: 'x', note: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('team mode login (HTTP)', () => {
  it('first-run setup, session cookie flags, logout, wrong password', async () => {
    const { app, db } = await teamApp();
    const c = client(app);
    expect((await c.query('session.status')).data).toMatchObject({ mode: 'team', needsSetup: true, authenticated: false, sso: null });
    expect((await c.query('projects.list')).status).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/artifacts/nope' })).statusCode).toBe(401);

    const setup = await c.mutate('session.setup', ADMIN);
    expect(setup.status).toBe(200);
    expect(setup.data).toMatchObject({ email: ADMIN.email, role: 'admin' });
    expect(JSON.stringify(setup.data)).not.toContain('argon2');
    const cookie = setup.cookies.find((x) => x.startsWith(`${SESSION_COOKIE}=`)) as string;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect((await c.query('session.me')).data).toMatchObject({ role: 'admin', email: ADMIN.email });
    expect((await c.query('projects.list')).status).toBe(200);
    expect((await c.query('session.status')).data).toMatchObject({ needsSetup: false, authenticated: true });
    // Setup is closed once a user exists.
    expect((await client(app).mutate('session.setup', { ...ADMIN, email: 'eve@example.com' })).error?.data.code).toBe('PRECONDITION_FAILED');

    // The password is stored as an argon2id hash.
    const stored = await repos.users.getByEmail(db, ADMIN.email);
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);

    await c.mutate('session.logout');
    expect((await client(app, { cookie: c.cookieRef.cookie as string }).query('projects.list')).status).toBe(401);

    const fresh = client(app);
    expect((await fresh.mutate('session.login', { email: ADMIN.email, password: 'wrong password here' })).status).toBe(401);
    expect((await fresh.mutate('session.login', { email: 'nobody@example.com', password: 'whatever whatever' })).status).toBe(401);
    expect((await fresh.mutate('session.login', { email: ADMIN.email, password: ADMIN.password })).status).toBe(200);
    expect((await fresh.query('projects.list')).status).toBe(200);
  });

  it('locks out after repeated failures', async () => {
    const { app } = await teamApp();
    const c = client(app);
    await c.mutate('session.setup', ADMIN);
    const other = client(app);
    for (let i = 0; i < 10; i++) await other.mutate('session.login', { email: ADMIN.email, password: 'bad password!!' });
    const blocked = await other.mutate('session.login', { email: ADMIN.email, password: ADMIN.password });
    expect(blocked.status).toBe(429);
  });

  it('invite flow: admin invites, invitee accepts, roles apply, deactivation ends the session', async () => {
    const { app, db } = await teamApp();
    const admin = client(app);
    await admin.mutate('session.setup', ADMIN);

    const invited = await admin.mutate('users.invite', { email: 'Tess@Example.com', role: 'tester' }, { origin: 'http://localhost', host: 'localhost' });
    expect(invited.status).toBe(200);
    const url = (invited.data as { inviteUrl: string }).inviteUrl;
    expect(url).toMatch(/^http:\/\/localhost\/invite\/[\w-]{20,}$/);
    const token = url.split('/invite/')[1] as string;
    // Only a hash of the token is stored.
    expect(JSON.stringify(await repos.users.invites.listOpen(db))).not.toContain(token);

    const tess = client(app);
    expect((await tess.query('session.inviteInfo', { token })).data).toMatchObject({ email: 'tess@example.com', role: 'tester' });
    expect((await tess.mutate('session.acceptInvite', { token, name: 'Tess', password: 'short' })).status).toBe(400);
    const accepted = await tess.mutate('session.acceptInvite', { token, name: 'Tess Tester', password: 'a long enough password' });
    expect(accepted.data).toMatchObject({ role: 'tester', email: 'tess@example.com' });
    expect((await tess.mutate('session.acceptInvite', { token, name: 'Again', password: 'a long enough password' })).error?.data.code).toBe('PRECONDITION_FAILED');
    expect((await tess.query('projects.list')).status).toBe(200);
    expect((await tess.query('users.list')).status).toBe(403);
    expect((await tess.mutate('plans.delete', 'x')).status).toBe(403);

    const list = (await admin.query('users.list')).data as { users: Array<{ id: string; email: string }> };
    const tessId = list.users.find((u) => u.email === 'tess@example.com')?.id as string;
    expect((await admin.mutate('users.setRole', { id: tessId, role: 'viewer' })).data).toMatchObject({ role: 'viewer' });
    expect((await tess.mutate('cases.create', { projectKey: 'X', title: 't', steps: [{ action: 'a' }] })).status).toBe(403);
    expect((await admin.mutate('users.setStatus', { id: tessId, status: 'deactivated' })).data).toMatchObject({ status: 'deactivated' });
    expect((await tess.query('projects.list')).status).toBe(401);
    expect((await client(app).mutate('session.login', { email: 'tess@example.com', password: 'a long enough password' })).status).toBe(401);

    // Cannot lock yourself or the last admin out.
    const adminId = list.users.find((u) => u.email === ADMIN.email)?.id as string;
    expect((await admin.mutate('users.setStatus', { id: adminId, status: 'deactivated' })).status).toBe(412);
    expect((await admin.mutate('users.setRole', { id: adminId, role: 'lead' })).status).toBe(412);

    const log = (await admin.query('audit.list', { action: 'user.*' })).data as { entries: Array<{ action: string }> };
    expect(log.entries.map((e) => e.action).sort()).toEqual(['user.deactivate', 'user.invite', 'user.role']);
    const logins = (await admin.query('audit.list', { action: 'auth.*' })).data as { entries: Array<{ action: string }> };
    expect(logins.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['auth.setup', 'auth.invite.accepted', 'auth.login.failed']));
  });

  it('rejects cookie-authenticated writes from another origin', async () => {
    const { app } = await teamApp();
    const c = client(app);
    await c.mutate('session.setup', ADMIN);
    const evil = await c.mutate('workspace.update', { name: 'pwned' }, { origin: 'https://evil.example', host: 'localhost' });
    expect(evil.status).toBe(403);
    const ok = await c.mutate('workspace.update', { name: 'fine' }, { origin: 'http://localhost', host: 'localhost' });
    expect(ok.status).toBe(200);
  });

  it('WebSocket and API routes need a session; API tokens still work', async () => {
    const { app, db } = await teamApp();
    const { cookie } = await signInAs(db, 'admin');
    expect((await app.inject({ method: 'GET', url: '/api/artifacts/nope' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/artifacts/nope', headers: { cookie } })).statusCode).toBe(404);
    const admin = makeCaller(createContext({ db, config: loadConfig({ mode: 'team', dataDir: '/tmp/x' }, {}), log: createLogger({ level: 'silent' }), user: { id: 'a', role: 'admin' } }));
    const { token } = await admin.tokens.create({ name: 'CI', scopes: ['runs:write', 'results:read'] });
    const viaToken = await app.inject({ method: 'GET', url: '/trpc/projects.list', headers: { authorization: `Bearer ${token}` } });
    expect(viaToken.statusCode).toBe(200);
  });
});

describe('owner references', () => {
  it('in team mode owner and plan assignees must be active users', async () => {
    const { db, config } = await teamApp();
    const log = createLogger({ level: 'silent' });
    const { userId } = await signInAs(db, 'tester');
    const { userId: gone } = await signInAs(db, 'tester');
    await repos.users.update(db, gone, { status: 'deactivated' });
    const lead = makeCaller(createContext({ db, config, log, user: { id: 'lead-1', role: 'lead' } }));
    await lead.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    const steps = [{ action: 'Open' }];
    await expect(lead.cases.create({ projectKey: 'SHOP', title: 'A', steps, owner: 'Some Name' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(lead.cases.create({ projectKey: 'SHOP', title: 'A', steps, owner: gone })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const c = await lead.cases.create({ projectKey: 'SHOP', title: 'A', steps, owner: userId });
    expect(c.owner).toBe(userId);
    await expect(lead.cases.update({ key: c.key, expectedVersion: 1, patch: { owner: 'nobody' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const env = (await lead.environments.list({ projectKey: 'SHOP' }))[0] as { id: string };
    const draft = { projectKey: 'SHOP', name: 'P', selection: { kind: 'list' as const, caseIds: [c.id] }, matrix: [{ environmentId: env.id, browser: 'chromium' as const }] };
    await expect(lead.plans.create({ ...draft, assignments: { [c.id]: { assignee: 'nobody' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(lead.plans.create({ ...draft, assignments: { [c.id]: { assignee: userId } } })).resolves.toMatchObject({ name: 'P' });
    const options = await lead.users.options();
    expect(options.map((o) => o.id)).toContain(userId);
    expect(options.map((o) => o.id)).not.toContain(gone);
  });
});

describe('sessions', () => {
  it('rotates the cookie token, keeps the old one valid briefly, then drops it', async () => {
    const { db } = await teamApp();
    const { userId } = await signInAs(db, 'tester');
    const user = (await repos.users.get(db, userId)) as NonNullable<Awaited<ReturnType<typeof repos.users.get>>>;
    const s = await createSession(db, user);
    const t0 = Date.now();
    const same = await resolveSession(db, s.token, t0 + 1000);
    expect(same?.rotated).toBeUndefined();
    const rotated = await resolveSession(db, s.token, t0 + ROTATE_AFTER_MS + 1000);
    expect(rotated?.rotated?.token).toBeTruthy();
    expect(rotated?.rotated?.token).not.toBe(s.token);
    // Both tokens work inside the grace period; the old one stops afterwards.
    expect(await resolveSession(db, rotated?.rotated?.token as string, t0 + ROTATE_AFTER_MS + 2000)).toBeDefined();
    expect(await resolveSession(db, s.token, t0 + ROTATE_AFTER_MS + 2000)).toBeDefined();
    expect(await resolveSession(db, s.token, t0 + ROTATE_AFTER_MS + 1000 + ROTATE_GRACE_MS + 5000)).toBeUndefined();
    expect(await resolveSession(db, rotated?.rotated?.token as string, t0 + ROTATE_AFTER_MS + 1000 + ROTATE_GRACE_MS + 5000)).toBeDefined();
    // Absolute expiry.
    expect(await resolveSession(db, rotated?.rotated?.token as string, t0 + 40 * 86_400_000)).toBeUndefined();
  });

  it('only a hash of the token is stored', async () => {
    const { db } = await teamApp();
    const { userId } = await signInAs(db, 'tester');
    const user = (await repos.users.get(db, userId)) as NonNullable<Awaited<ReturnType<typeof repos.users.get>>>;
    const s = await createSession(db, user);
    const rows = await repos.users.sessions.listForUser(db, userId);
    expect(JSON.stringify(rows)).not.toContain(s.token);
  });
});
