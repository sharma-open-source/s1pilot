import { looksLikeSecretKey } from '@s1pilot/domain';
import { useEffect, useRef, useState } from 'react';

import { newRid, SECRET_LIKE_KEY_MESSAGE, VAR_KIND_LABEL, type FormErrors, type VarKind, type VarRow } from './model';

import { Button, Card, CardHeader, Input, Select, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const MASK = '••••••••••';

/**
 * Masked secret with a Reveal button. The plaintext lives only in this component's state: it is fetched with the
 * untyped-cache client (no query/mutation cache entry) and dropped on blur or unmount.
 */
export function SecretValue({ envId, secretKey }: { envId: string; secretKey: string }) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (value !== null) input.current?.focus();
  }, [value]);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await utils.client.environments.revealSecret.mutate({ envId, key: secretKey });
      setValue(res.value);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {value === null ? (
        <>
          <span aria-label="Secret value hidden">{MASK}</span>
          <Button key="reveal" size="sm" disabled={busy} aria-label={`Reveal ${secretKey}`} onClick={() => void reveal()}>
            {busy ? 'Revealing…' : 'Reveal'}
          </Button>
        </>
      ) : (
        <>
          <input
            ref={input}
            readOnly
            aria-label={`${secretKey} value`}
            value={value}
            onBlur={() => setValue(null)}
            className="h-[36px] w-48 rounded-tag border border-line-input bg-surface-subtle px-2 font-mono text-[13px] text-fg"
          />
          <Button key="hide" size="sm" onClick={() => setValue(null)}>
            Hide
          </Button>
        </>
      )}
      {error !== null && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

function ValueCell({
  row,
  envId,
  error,
  onChange,
}: {
  row: VarRow;
  envId: string;
  error: { value?: string; envVar?: string } | undefined;
  onChange: (patch: Partial<VarRow>) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const fieldError = error?.value ?? error?.envVar;
  const errorEl =
    fieldError !== undefined ? (
      <span role="alert" className="block text-xs text-danger">
        {fieldError}
      </span>
    ) : null;
  if (row.kind === 'secret-env' || (row.kind === 'variable' && row.source === 'env')) {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 font-mono text-[13px] text-secondary">
          from env
          <Input
            mono
            aria-label={`Host variable for ${row.key || 'new row'}`}
            value={row.envVar}
            placeholder="S1P_TEST_CARD"
            className="h-[36px] w-44 text-[13px]"
            aria-invalid={error?.envVar !== undefined}
            onChange={(e) => onChange({ envVar: e.target.value })}
          />
        </label>
        {errorEl}
      </div>
    );
  }
  if (row.kind === 'secret-encrypted' && row.existing && !replacing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-[13px]">
        <SecretValue envId={envId} secretKey={row.key} />
        <Button size="sm" aria-label={`Replace ${row.key}`} onClick={() => setReplacing(true)}>
          Replace
        </Button>
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Input
        mono
        aria-label={`Value for ${row.key || 'new row'}`}
        type={row.kind === 'variable' ? 'text' : 'password'}
        autoComplete="off"
        value={row.value}
        placeholder={row.kind === 'variable' ? 'value' : row.existing ? 'new secret value' : 'secret value'}
        className="h-[36px] min-w-40 text-[13px]"
        aria-invalid={error?.value !== undefined}
        onChange={(e) => onChange({ value: e.target.value })}
      />
      {errorEl}
    </div>
  );
}

/** Variables & secrets table with an inline row editor behind "+ Add". */
export function VariablesCard({
  envId,
  rows,
  errors,
  onChange,
}: {
  envId: string;
  rows: VarRow[];
  errors: FormErrors['variables'];
  onChange: (rows: VarRow[]) => void;
}) {
  const patchRow = (rid: string, patch: Partial<VarRow>) => onChange(rows.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));
  const setKind = (rid: string, kind: VarKind) =>
    patchRow(rid, { kind, source: kind === 'secret-env' ? 'env' : 'inline', value: '', envVar: '' });
  return (
    <Card aria-label="Variables" className="flex flex-col">
      <CardHeader
        title="Variables & secrets"
        action={
          <Button
            variant="dashed"
            onClick={() =>
              onChange([...rows, { rid: newRid(), key: '', kind: 'variable', value: '', envVar: '', source: 'inline', existing: false }])
            }
          >
            + Add
          </Button>
        }
      />
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-secondary">
              <th scope="col" className="px-5 py-2.5 font-medium">Key</th>
              <th scope="col" className="px-2.5 py-2.5 font-medium">Value</th>
              <th scope="col" className="px-2.5 py-2.5 font-medium">Type</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Sent to models</th>
              <th scope="col" className="px-2.5 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="border-t border-divider">
                <td colSpan={5} className="px-5 py-4 text-secondary">
                  No variables yet. Add one to reference it as <span className="font-mono">var:key</span> or <span className="font-mono">secret:key</span> in steps.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const err = errors[row.rid];
              const secret = row.kind !== 'variable';
              const secretLike = !secret && looksLikeSecretKey(row.key.trim());
              const keyError = err?.key === SECRET_LIKE_KEY_MESSAGE ? undefined : err?.key;
              return (
                <tr key={row.rid} className="border-t border-divider align-top">
                  <td className="px-5 py-3 font-mono text-[13px]">
                    {row.existing && secret ? (
                      row.key
                    ) : (
                      <div className="flex flex-col gap-1">
                        <Input
                          mono
                          aria-label={row.key ? `Key ${row.key}` : 'New variable key'}
                          value={row.key}
                          placeholder="key"
                          className="h-[36px] w-40 text-[13px]"
                          aria-invalid={err?.key !== undefined}
                          onChange={(e) => patchRow(row.rid, { key: e.target.value })}
                        />
                        {keyError !== undefined && (
                          <span role="alert" className="text-xs text-danger">
                            {keyError}
                          </span>
                        )}
                        {secretLike && (
                          <div role={err?.key === SECRET_LIKE_KEY_MESSAGE ? 'alert' : undefined} className="flex max-w-56 flex-col gap-1.5 font-sans text-xs text-danger">
                            {SECRET_LIKE_KEY_MESSAGE}.
                            <Button
                              size="sm"
                              className="self-start"
                              aria-label={`Store ${row.key} as a secret`}
                              onClick={() =>
                                patchRow(row.rid, row.source === 'env' ? { kind: 'secret-env', existing: false } : { kind: 'secret-encrypted', existing: false, envVar: '' })
                              }
                            >
                              Store as secret
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2.5 py-3 font-mono text-[13px]">
                    <ValueCell row={row} envId={envId} error={err} onChange={(p) => patchRow(row.rid, p)} />
                  </td>
                  <td className="px-2.5 py-3">
                    {row.existing ? (
                      secret ? <Tag tone="danger">{VAR_KIND_LABEL[row.kind]}</Tag> : 'Variable'
                    ) : (
                      <Select
                        aria-label={`Type for ${row.key || 'new row'}`}
                        value={row.kind}
                        className="h-[36px] text-[13px]"
                        onChange={(e) => setKind(row.rid, e.target.value as VarKind)}
                      >
                        {(Object.keys(VAR_KIND_LABEL) as VarKind[]).map((k) => (
                          <option key={k} value={k}>
                            {VAR_KIND_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className={secret || secretLike ? 'px-5 py-3 font-medium text-danger' : 'px-5 py-3'}>
                    {secret ? 'Key name only' : secretLike ? 'Key name only (treated as a secret at run time)' : 'Key + value'}
                  </td>
                  <td className="px-2.5 py-3">
                    <Button size="sm" aria-label={`Remove ${row.key || 'new row'}`} onClick={() => onChange(rows.filter((r) => r.rid !== row.rid))}>
                      Remove
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
