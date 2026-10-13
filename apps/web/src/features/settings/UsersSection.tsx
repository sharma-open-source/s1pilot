import { ROLES, type Role } from '@s1pilot/domain';
import { useState } from 'react';

import { ago } from './model';
import { RolesOverview } from './RolesOverview';

import { CodeBlock } from '@/components/app/CodeBlock';
import { Button, Callout, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, Field, Input, Select, Skeleton, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useSessionUser } from '@/lib/session';
import { trpc } from '@/lib/trpc';

const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', lead: 'QA lead', tester: 'Tester', viewer: 'Viewer' };

/**
 * Invite dialog. The link comes back once, through the vanilla client (not the query cache), and is shown until the
 * dialog is closed: only a hash of its token is stored.
 */
function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('tester');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = (o: boolean) => {
    if (!o) {
      setEmail('');
      setRole('tester');
      setLink(null);
      setError(null);
    }
    onOpenChange(o);
  };

  const invite = async () => {
    setError(null);
    setPending(true);
    try {
      const r = await utils.client.users.invite.mutate({ email, role });
      setLink(r.inviteUrl);
      await utils.users.list.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (link !== null) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Share the invite link"
        description={`Send this link to ${email}. It works once and expires in 7 days.`}
        footer={
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        }
      >
        <CodeBlock code={link} label="Invite link" />
        <Callout tone="warning">The link is shown only now. Create a new invite if it gets lost.</Callout>
      </Dialog>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Invite a user"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || !email.includes('@')} onClick={() => void invite()}>
            Create invite link
          </Button>
        </>
      }
    >
      <Field label="Email">{(id) => <Input id={id} type="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Role">
        {(id) => (
          <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

/** Settings › Users & roles: list, invite, change role, deactivate (admins). Local mode shows the role overview only. */
export function UsersSection() {
  const me = useSessionUser();
  if (me !== null && me.mode !== 'team') {
    return (
      <>
        <Callout tone="warning">
          Users and roles need team mode. Start the server with <span className="font-mono">S1PILOT_MODE=team</span> to turn on sign-in; until then everyone on this machine is the local admin.
        </Callout>
        <RolesOverview />
      </>
    );
  }
  return <TeamUsers selfId={me?.id ?? null} />;
}

function TeamUsers({ selfId }: { selfId: string | null }) {
  const utils = trpc.useUtils();
  const q = trpc.users.list.useQuery();
  const setRole = trpc.users.setRole.useMutation();
  const setStatus = trpc.users.setStatus.useMutation();
  const revokeInvite = trpc.users.revokeInvite.useMutation();
  const [inviting, setInviting] = useState(false);
  const [deactivating, setDeactivating] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await utils.users.list.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <Card aria-label="Users and roles">
        <CardHeader
          title="Users & roles"
          action={
            <Button variant="primary" onClick={() => setInviting(true)}>
              Invite user
            </Button>
          }
        />
        <div className="flex flex-col gap-3 p-[18px]">
          {error !== null && <Callout tone="danger">{error}</Callout>}
          {q.isLoading && (
            <div aria-busy="true" className="flex flex-col gap-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          )}
          {q.error && <Callout tone="danger">{errorMessage(q.error)}</Callout>}
          {q.data && q.data.users.length === 0 && <EmptyState>No users yet.</EmptyState>}
          {q.data && q.data.users.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0">
              {q.data.users.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-divider-row py-3 last:border-b-0">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">
                      {u.name} {u.id === selfId && <Tag>you</Tag>} {u.status === 'deactivated' && <Tag tone="danger">Deactivated</Tag>} {u.sso && <Tag>SSO</Tag>}
                    </span>
                    <span className="font-mono text-xs text-secondary">{u.email}</span>
                    <span className="text-xs text-secondary">Last sign-in: {ago(u.lastLoginAt)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label={`Role of ${u.name}`}
                      className="w-[150px]"
                      value={u.role}
                      disabled={u.status === 'deactivated'}
                      onChange={(e) => void run(() => setRole.mutateAsync({ id: u.id, role: e.target.value as Role }))}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                    {u.status === 'active' ? (
                      <Button
                        variant="danger-outline"
                        aria-label={`Deactivate ${u.name}`}
                        disabled={u.id === selfId}
                        onClick={() => setDeactivating({ id: u.id, name: u.name })}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button aria-label={`Reactivate ${u.name}`} onClick={() => void run(() => setStatus.mutateAsync({ id: u.id, status: 'active' }))}>
                        Reactivate
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {q.data && q.data.invites.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[13px] font-semibold text-fg">Pending invites</h3>
              <ul className="m-0 flex list-none flex-col p-0">
                {q.data.invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-divider-row py-2.5 last:border-b-0">
                    <span className="text-sm">
                      <span className="font-mono">{i.email}</span> · {ROLE_LABEL[i.role]}
                    </span>
                    <Button aria-label={`Revoke invite for ${i.email}`} onClick={() => void run(() => revokeInvite.mutateAsync({ id: i.id }))}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
      <RolesOverview />
      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(o) => !o && setDeactivating(null)}
        title={`Deactivate ${deactivating?.name ?? 'user'}?`}
        description="They are signed out at once and cannot sign in again until reactivated. Their history stays."
        confirmLabel="Deactivate"
        tone="danger"
        onConfirm={() => {
          const target = deactivating;
          setDeactivating(null);
          if (target) void run(() => setStatus.mutateAsync({ id: target.id, status: 'deactivated' }));
        }}
      />
    </>
  );
}
