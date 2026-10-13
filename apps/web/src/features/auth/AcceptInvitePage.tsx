import { useState, type FormEvent } from 'react';

import { AuthFrame, leaveAuthPath } from './LoginPage';

import { Button, Callout, Field, Input, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

/** `/invite/:token`: shows who the invite is for and lets them choose a name and password. */
export function AcceptInvitePage({ token }: { token: string }) {
  const utils = trpc.useUtils();
  const info = trpc.session.inviteInfo.useQuery({ token });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await utils.client.session.acceptInvite.mutate({ token, name, password });
      setPassword('');
      leaveAuthPath();
      await utils.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (info.isLoading) {
    return (
      <AuthFrame title="Join s1-pilot">
        <div aria-busy="true" className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthFrame>
    );
  }
  if (info.error || !info.data) {
    return (
      <AuthFrame title="Invite not valid">
        <Callout tone="danger">{info.error ? errorMessage(info.error) : 'This invite link is not valid.'}</Callout>
        <a href="/" className="text-sm">
          Go to sign in
        </a>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Join s1-pilot" intro={`You were invited as ${info.data.role}. Choose a name and password to finish.`}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5">
        <Field label="Email">{(id) => <Input id={id} value={info.data.email} readOnly autoComplete="username" />}</Field>
        <Field label="Name">{(id) => <Input id={id} value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Password" hint="At least 10 characters.">
          {(id) => <Input id={id} type="password" value={password} autoComplete="new-password" minLength={10} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        {error !== null && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" variant="primary" disabled={pending || name.trim() === '' || password.length < 10}>
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}
