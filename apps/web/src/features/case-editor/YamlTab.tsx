import { useEffect, useMemo, useState } from 'react';

import { validateYaml } from './yaml-validate';
import { YamlEditor } from './YamlEditor';

import { Button, Callout, Skeleton } from '@/components/ui';
import { errorMessage, trpcCode } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type CaseRecord = RouterOutputs['cases']['updateFromYaml'];

interface YamlTabProps {
  caseKey: string;
  /** Unsaved edits exist on the other tabs; applying YAML replaces them. */
  hasUnsavedEdits: boolean;
  /** Called with the stored case after YAML was applied. */
  onApplied: (c: CaseRecord) => void;
}

/** YAML tab: Monaco editor, client-side validation, apply via `cases.updateFromYaml`. */
export function YamlTab({ caseKey, hasUnsavedEdits, onApplied }: YamlTabProps) {
  const query = trpc.cases.yaml.useQuery({ key: caseKey });
  const utils = trpc.useUtils();
  const apply = trpc.cases.updateFromYaml.useMutation();
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [checked, setChecked] = useState<'idle' | 'valid'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const serverYaml = query.data?.yaml;
  useEffect(() => {
    if (serverYaml !== undefined && !edited) setText(serverYaml);
  }, [serverYaml, edited]);

  const markers = useMemo(() => (edited ? validateYaml(text) : []), [edited, text]);

  const reload = async () => {
    setEdited(false);
    setConflict(false);
    setError(null);
    setChecked('idle');
    await utils.cases.yaml.invalidate({ key: caseKey });
    const fresh = await utils.cases.yaml.fetch({ key: caseKey }, { staleTime: 0 });
    setText(fresh.yaml);
  };

  const submit = async () => {
    const found = validateYaml(text);
    if (found.length > 0 || query.data === undefined) return;
    setError(null);
    setConflict(false);
    try {
      const saved = await apply.mutateAsync({ key: caseKey, yaml: text, expectedVersion: query.data.version });
      setEdited(false);
      setChecked('idle');
      await utils.cases.invalidate();
      onApplied(saved);
    } catch (err) {
      if (trpcCode(err) === 'CONFLICT') setConflict(true);
      else setError(errorMessage(err));
    }
  };

  if (query.isPending) return <Skeleton className="h-[480px] w-full" />;
  if (query.isError) return <Callout tone="danger">Could not load the YAML: {errorMessage(query.error)}</Callout>;

  return (
    <section aria-label="YAML" className="flex flex-col gap-3">
      <p className="m-0 max-w-[70ch] text-sm text-secondary">
        Same format as the tests-as-code files in <span className="font-mono">.s1pilot/</span>. Applying creates a new version.
      </p>
      {hasUnsavedEdits && <Callout tone="warning">You have unsaved edits on the other tabs. Applying YAML replaces them with the YAML content.</Callout>}
      {conflict && (
        <Callout tone="danger" data-testid="yaml-conflict">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>This case changed since the YAML was loaded (it is now at a newer version). Reload to see the latest YAML; your edits will be discarded.</span>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              Reload latest
            </Button>
          </div>
        </Callout>
      )}
      <YamlEditor
        label="Case YAML"
        value={text}
        markers={markers}
        onSave={() => void submit()}
        onChange={(v) => {
          setText(v);
          setEdited(true);
          setChecked('idle');
        }}
      />
      {markers.length > 0 && (
        <Callout tone="danger">
          <ul className="m-0 list-none p-0">
            {markers.map((m, i) => (
              <li key={i}>
                Line {m.line}, column {m.column}: {m.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {checked === 'valid' && markers.length === 0 && <Callout tone="success">YAML is valid.</Callout>}
      {error !== null && <Callout tone="danger">{error}</Callout>}
      <div className="flex flex-wrap gap-2.5">
        <Button variant="secondary" onClick={() => setChecked('valid')} disabled={markers.length > 0}>
          Validate
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!edited || markers.length > 0 || apply.isPending}>
          {apply.isPending ? 'Applying…' : 'Apply YAML'}
        </Button>
        <Button variant="secondary" onClick={() => void reload()} disabled={!edited}>
          Discard changes
        </Button>
      </div>
    </section>
  );
}
