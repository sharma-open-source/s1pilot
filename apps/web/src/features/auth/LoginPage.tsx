import { useState, type FormEvent, type ReactNode } from 'react';

import { Button, Callout, Card, Field, Input } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

/** Full-page centre column for the sign-in, first-run and invite screens (no app navigation around it). */
export function AuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-4 py-10">
      <Card className="flex w-full max-w-[420px] flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-secondary">s1-pilot</span>
          <h1 className="m-0 text-xl font-semibold text-fg">{title}</h1>
          {intro !== undefined && <p className="m-0 text-sm text-secondary">{intro}</p>}
        </div>
        {children}
      </Card>
    </main>
  );
}

/** After signing in from `/login` or an invite link, move the address bar to the app root; deep links stay where they are. */
export function leaveAuthPath(): void {
  try {
    if (/^\/(login|invite\/)/.test(window.location.pathname)) window.history.replaceState(null, '', '/');
  } catch {
    /* history unavailable: the gate redirects anyway */
  }
}

/** `?error=` from a failed SSO redirect, if any. */
function ssoError(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('error');
  } catch {
    return null;
  }
}

/**
 * Team-mode sign-in (S-067): email + password, optional SSO button, and the first-run form that creates the
 * first admin while the workspace has no users. Passwords go through the vanilla client so they never enter the query cache.
 */
export function LoginPage({ needsSetup, sso }: { needsSetup: boolean; sso: { label: string } | null }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(ssoError());
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (needsSetup) await utils.client.session.setup.mutate({ email, name, password });
      else await utils.client.session.login.mutate({ email, password });
      setPassword('');
      leaveAuthPath();
      await utils.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthFrame
      title={needsSetup ? 'Create the first admin' : 'Sign in'}
      intro={needsSetup ? 'This workspace has no users yet. The account you create here becomes its admin.' : undefined}
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5">
        {needsSetup && <Field label="Name">{(id) => <Input id={id} value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} required />}</Field>}
        <Field label="Email">
          {(id) => <Input id={id} type="email" value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Password" hint={needsSetup ? 'At least 10 characters.' : undefined}>
          {(id) => (
            <Input
              id={id}
              type="password"
              value={password}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              minLength={needsSetup ? 10 : undefined}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        {error !== null && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" variant="primary" disabled={pending || email === '' || password === '' || (needsSetup && name.trim() === '')}>
          {needsSetup ? 'Create admin account' : 'Sign in'}
        </Button>
      </form>
      {sso !== null && !needsSetup && (
        <>
          <div className="flex items-center gap-3 text-xs text-secondary" aria-hidden="true">
            <span className="h-px flex-1 bg-divider-row" />
            or
            <span className="h-px flex-1 bg-divider-row" />
          </div>
          <a
            href="/api/auth/oidc/login"
            className="inline-flex min-h-[44px] items-center justify-center rounded-control border border-line-input bg-surface px-4 text-sm font-medium text-fg no-underline hover:bg-surface-muted"
          >
            Continue with {sso.label}
          </a>
        </>
      )}
    </AuthFrame>
  );
}
