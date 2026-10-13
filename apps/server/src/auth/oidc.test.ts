import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

import { createInvite } from './accounts.js';
import { SESSION_COOKIE } from './sessions.js';

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

interface Grant {
  nonce: string;
  challenge: string;
  redirectUri: string;
  email: string | undefined;
  sub: string;
}

/** A tiny standards-shaped OIDC provider: discovery, JWKS, authorize (auto-approves), token (PKCE-checked, RS256 id_token). */
async function mockProvider(clientId: string, clientSecret: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const app: FastifyInstance = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  const grants = new Map<string, Grant>();
  let user: { sub: string; email?: string; name?: string; verified?: boolean } = { sub: 'sub-1', email: 'sso@example.com', name: 'Sso User' };
  let issuer = ''; // known once listening; routes read it per request

  app.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
  }));
  app.get('/jwks', async () => ({ keys: [jwk] }));
  app.get<{ Querystring: Record<string, string> }>('/authorize', async (req, reply) => {
    const q = req.query;
    if (q['client_id'] !== clientId || q['code_challenge_method'] !== 'S256' || !q['state'] || !q['nonce']) return reply.code(400).send('bad request');
    const code = randomBytes(8).toString('hex');
    grants.set(code, { nonce: q['nonce'], challenge: q['code_challenge'] as string, redirectUri: q['redirect_uri'] as string, email: user.email, sub: user.sub });
    return reply.redirect(`${q['redirect_uri']}?code=${code}&state=${encodeURIComponent(q['state'])}`);
  });
  app.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
    const b = req.body;
    const grant = grants.get(b['code'] ?? '');
    const basic = req.headers.authorization ? Buffer.from(req.headers.authorization.replace(/^Basic /i, ''), 'base64').toString() : '';
    const secretOk = b['client_secret'] === clientSecret || basic === `${clientId}:${clientSecret}`;
    if (!grant || !secretOk || b['redirect_uri'] !== grant.redirectUri || b['grant_type'] !== 'authorization_code') return reply.code(400).send({ error: 'invalid_grant' });
    if (b64(createHash('sha256').update(b['code_verifier'] ?? '').digest()) !== grant.challenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE' });
    grants.delete(b['code'] as string);
    const now = Math.floor(Date.now() / 1000);
    const header = b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const payload = b64(JSON.stringify({ iss: issuer, sub: grant.sub, aud: clientId, iat: now, exp: now + 300, nonce: grant.nonce, ...(user.email ? { email: user.email, email_verified: user.verified ?? true } : {}), name: user.name }));
    const signature = b64(createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey));
    return { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: `${header}.${payload}.${signature}` };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  issuer = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  closers.push(() => app.close());
  return { issuer, setUser: (u: typeof user) => (user = u) };
}

async function setup() {
  const clientId = 's1pilot-test';
  const clientSecret = 'shh-its-a-secret';
  const provider = await mockProvider(clientId, clientSecret);
  const dir = mkdtempSync(join(tmpdir(), 's1pilot-oidc-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig(
    { dataDir: join(dir, '.s1pilot'), mode: 'team', logLevel: 'silent', workers: 0, publicUrl: 'http://s1pilot.test', oidc: { issuer: provider.issuer, clientId, clientSecret, label: 'Acme SSO' } },
    {},
  );
  const app = await buildApp(config, { db, workers: 0, dev: false, scheduler: false, trackerSync: false, webDist: join(dir, 'none') });
  closers.push(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** Runs the whole browser dance: our /login -> provider /authorize -> our /callback. */
  const signIn = async () => {
    const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    expect(start.statusCode).toBe(302);
    const authorize = new URL(start.headers.location as string);
    expect(authorize.origin).toBe(provider.issuer);
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://s1pilot.test/api/auth/oidc/callback');
    const approved = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(approved.headers.get('location') as string);
    return app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
  };
  return { app, db, provider, signIn };
}

const cookieOf = (res: { headers: Record<string, unknown> }): string | undefined => {
  const set = res.headers['set-cookie'];
  return ([] as string[]).concat((set as string | string[] | undefined) ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
};

describe('OIDC single sign-on (mock provider)', () => {
  it('advertises the SSO button on the status endpoint', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/trpc/session.status' });
    expect(JSON.parse(res.body).result.data).toMatchObject({ sso: { label: 'Acme SSO' } });
  });

  it('signs in an invited user: creates the account with the invited role and a working session', async () => {
    const { app, db, signIn } = await setup();
    await createInvite(db, { email: 'sso@example.com', role: 'lead', createdBy: 'admin' });
    const done = await signIn();
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/');
    const cookie = cookieOf(done);
    expect(cookie).toMatch(/HttpOnly/);
    const me = await app.inject({ method: 'GET', url: '/trpc/session.me', headers: { cookie: (cookie as string).split(';')[0] as string } });
    expect(JSON.parse(me.body).result.data).toMatchObject({ email: 'sso@example.com', role: 'lead', name: 'Sso User' });
    const user = await repos.users.getByEmail(db, 'sso@example.com');
    expect(user).toMatchObject({ role: 'lead', passwordHash: null, oidcSubject: 'sub-1' });
    expect(await repos.users.invites.listOpen(db)).toEqual([]);
    const entries = await repos.audit.list(db, { action: 'auth.login.sso' });
    expect(entries).toHaveLength(1);
  });

  it('links an existing user by verified email, then recognises them by subject', async () => {
    const { db, provider, signIn } = await setup();
    await repos.users.create(db, { id: newId(), email: 'sso@example.com', name: 'Existing', passwordHash: null, role: 'tester', status: 'active', oidcIssuer: null, oidcSubject: null, createdAt: new Date().toISOString() });
    expect((await signIn()).statusCode).toBe(302);
    expect(await repos.users.getByOidc(db, provider.issuer, 'sub-1')).toMatchObject({ role: 'tester', name: 'Existing' });
    // The email changed at the provider, the subject still matches.
    provider.setUser({ sub: 'sub-1', email: 'renamed@example.com', name: 'X' });
    const again = await signIn();
    expect(cookieOf(again)).toBeTruthy();
    expect(await repos.users.count(db)).toBe(1);
  });

  it('refuses people without an account or invite, unverified emails, and deactivated users', async () => {
    const { db, provider, signIn } = await setup();
    const unknown = await signIn();
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers.location).toMatch(/^\/login\?error=.*No%20account/);
    expect(cookieOf(unknown)).toBeUndefined();
    expect(await repos.users.count(db)).toBe(0);

    provider.setUser({ sub: 'sub-2', email: 'x@example.com', verified: false });
    await createInvite(db, { email: 'x@example.com', role: 'viewer', createdBy: 'admin' });
    expect(cookieOf(await signIn())).toBeUndefined();

    provider.setUser({ sub: 'sub-3', email: 'gone@example.com' });
    await repos.users.create(db, { id: newId(), email: 'gone@example.com', name: 'Gone', passwordHash: null, role: 'tester', status: 'deactivated', oidcIssuer: null, oidcSubject: null, createdAt: new Date().toISOString() });
    const gone = await signIn();
    expect(gone.headers.location).toMatch(/deactivated/);
    expect(cookieOf(gone)).toBeUndefined();
  });

  it('rejects a replayed or forged callback', async () => {
    const { app, signIn } = await setup();
    const forged = await app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=abc&state=forged' });
    expect(forged.headers.location).toMatch(/^\/login\?error=/);
    expect(cookieOf(forged)).toBeUndefined();
    const first = await signIn();
    const replay = await app.inject({ method: 'GET', url: String(first.headers.location) });
    expect(cookieOf(replay)).toBeUndefined();
  });
});
