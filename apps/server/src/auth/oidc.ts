import { repos, type Db, type UserRecord } from '@s1pilot/db';
import { S1PilotError, newId } from '@s1pilot/domain';
import * as client from 'openid-client';

import type { OidcConfig } from '../config.js';

import { sha256 } from './credentials.js';

const PENDING_TTL_MS = 10 * 60_000;
const pendingKey = (state: string): string => `auth.oidc.pending.${sha256(state)}`;

interface Pending {
  verifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

/**
 * OpenID Connect login (authorization code flow with PKCE) against any standards-compliant provider
 * (Google, Azure AD / Entra, Okta, Keycloak, …). Users are never created implicitly: the email must belong
 * to an existing user or an open invite.
 */
export class OidcService {
  private discovered: Promise<client.Configuration> | undefined;

  constructor(
    private readonly db: Db,
    private readonly cfg: OidcConfig,
  ) {}

  get label(): string {
    return this.cfg.label ?? 'Single sign-on';
  }

  private configuration(): Promise<client.Configuration> {
    const issuer = new URL(this.cfg.issuer);
    this.discovered ??= client
      .discovery(issuer, this.cfg.clientId, this.cfg.clientSecret, undefined, issuer.protocol === 'http:' && (isLoopback(issuer) || this.cfg.allowInsecure) ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((error: unknown) => {
        this.discovered = undefined; // retry on the next attempt
        throw new S1PilotError('AUTH_OIDC_UNAVAILABLE', `OIDC discovery failed for ${this.cfg.issuer}: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.discovered;
  }

  /** URL of the provider's login page; remembers state, nonce and PKCE verifier for the callback. */
  async begin(redirectUri: string): Promise<URL> {
    const config = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const pending: Pending = { verifier, nonce, redirectUri, expiresAt: Date.now() + PENDING_TTL_MS };
    await repos.settings.set(this.db, pendingKey(state), pending);
    return client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: this.cfg.scopes ?? 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
  }

  /** Completes the login from the provider's redirect back to us and returns the matching user. */
  async complete(callbackUrl: URL): Promise<UserRecord> {
    const state = callbackUrl.searchParams.get('state');
    if (!state) throw new S1PilotError('UNAUTHORIZED', 'Missing OIDC state');
    const key = pendingKey(state);
    const pending = (await repos.settings.get(this.db, key)) as Pending | undefined;
    await repos.settings.delete(this.db, key); // single use
    if (!pending || pending.expiresAt < Date.now()) throw new S1PilotError('UNAUTHORIZED', 'The sign-in attempt expired. Start again.');
    const config = await this.configuration();
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      throw new S1PilotError('UNAUTHORIZED', `OIDC sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!claims) throw new S1PilotError('UNAUTHORIZED', 'The provider returned no ID token');
    return this.userFor(claims);
  }

  private async userFor(claims: client.IDToken): Promise<UserRecord> {
    const issuer = this.cfg.issuer;
    const subject = claims.sub;
    const email = typeof claims['email'] === 'string' ? claims['email'].toLowerCase() : undefined;
    const name = typeof claims['name'] === 'string' && claims['name'] ? claims['name'] : (email ?? subject);
    const bound = await repos.users.getByOidc(this.db, issuer, subject);
    if (bound) return this.active(bound);
    if (!email || claims['email_verified'] === false) {
      throw new S1PilotError('FORBIDDEN', 'The provider did not return a verified email address');
    }
    const existing = await repos.users.getByEmail(this.db, email);
    if (existing) {
      const user = await this.active(existing);
      await repos.users.update(this.db, user.id, { oidcIssuer: issuer, oidcSubject: subject });
      return { ...user, oidcIssuer: issuer, oidcSubject: subject };
    }
    const now = new Date().toISOString();
    const invite = await repos.users.invites.getOpenByEmail(this.db, email, now);
    if (!invite) throw new S1PilotError('FORBIDDEN', `No account for ${email}. Ask an admin for an invite.`);
    const created = await repos.users.create(this.db, {
      id: newId(),
      email,
      name,
      passwordHash: null,
      role: invite.role,
      status: 'active',
      oidcIssuer: issuer,
      oidcSubject: subject,
      createdAt: now,
    });
    await repos.users.invites.markAccepted(this.db, invite.id, now);
    return created;
  }

  private async active(user: UserRecord): Promise<UserRecord> {
    if (user.status !== 'active') throw new S1PilotError('FORBIDDEN', 'This account is deactivated');
    return user;
  }
}
