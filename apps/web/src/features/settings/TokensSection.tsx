import { useState } from 'react';

import { CiSetup } from './CiSetup';
import { ago, TOKEN_SCOPE_LABELS } from './model';

import { CodeBlock } from '@/components/app/CodeBlock';
import { Button, Callout, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, Skeleton, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

type Scope = keyof typeof TOKEN_SCOPE_LABELS;
const SCOPES = Object.keys(TOKEN_SCOPE_LABELS) as Scope[];

/**
 * Create-token dialog. Creation goes through the vanilla client, so the plaintext token never enters the react-query
 * cache; it lives in this component's state only until the dialog is closed.
 */
function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>([...SCOPES]);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = (o: boolean) => {
    if (!o) {
      setToken(null);
      setName('');
      setScopes([...SCOPES]);
      setError(null);
    }
    onOpenChange(o);
  };

  const create = async () => {
    setError(null);
    setPending(true);
    try {
      const r = await utils.client.tokens.create.mutate({ name, scopes });
      setToken(r.token);
      await utils.tokens.list.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (token !== null) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title="Copy your API token"
        description="This is the only time the token is shown. Store it as a secret in your CI, for example S1P_TOKEN."
        footer={
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        }
      >
        <CodeBlock code={token} label="API token" />
        <Callout tone="warning">After you close this dialog only the token prefix is visible.</Callout>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Create API token"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || name.trim() === '' || scopes.length === 0} onClick={() => void create()}>
            Create token
          </Button>
        </>
      }
    >
      <Field label="Name" hint="For example github-actions">
        {(id) => <Input id={id} value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />}
      </Field>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-[13px] font-medium text-fg">Scopes</legend>
        {SCOPES.map((s) => (
          <Checkbox
            key={s}
            label={
              <>
                <span className="font-mono">{s}</span> · {TOKEN_SCOPE_LABELS[s]}
              </>
            }
            checked={scopes.includes(s)}
            onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
          />
        ))}
      </fieldset>
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

/** API tokens & CLI: token list (prefix only), create and revoke, plus the CI command. */
export function TokensSection() {
  const utils = trpc.useUtils();
  const q = trpc.tokens.list.useQuery();
  const revoke = trpc.tokens.revoke.useMutation();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doRevoke = async (id: string) => {
    setRevoking(null);
    setError(null);
    try {
      await revoke.mutateAsync({ id });
      await utils.tokens.list.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <Card aria-label="API tokens">
        <CardHeader
          title="API tokens"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create API token
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
          {q.data && q.data.length === 0 && (
            <EmptyState>No API tokens yet. Create one to run plans from CI or the terminal.</EmptyState>
          )}
          {q.data && q.data.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0">
              {q.data.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-divider-row py-3 last:border-b-0">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-fg">
                      {t.name} {t.revokedAt && <Tag tone="danger">Revoked</Tag>}
                    </span>
                    <span className="font-mono text-xs text-secondary">{t.prefix}…</span>
                    <span className="flex flex-wrap gap-1.5">
                      {t.scopes.map((s) => (
                        <Tag key={s} mono>
                          {s}
                        </Tag>
                      ))}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-secondary">Last used: {ago(t.lastUsedAt)}</span>
                    {!t.revokedAt && (
                      <Button variant="danger-outline" aria-label={`Revoke ${t.name}`} onClick={() => setRevoking({ id: t.id, name: t.name })}>
                        Revoke
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <CiSetup />
      <CreateTokenDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'token'}?`}
        description="Anything using this token gets 401 immediately. This cannot be undone."
        confirmLabel="Revoke"
        tone="danger"
        onConfirm={() => revoking !== null && void doRevoke(revoking.id)}
      />
    </>
  );
}
