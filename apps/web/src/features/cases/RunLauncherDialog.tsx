import { useEffect, useState } from 'react';

import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const MODES = [
  { value: 'replay-heal', label: 'Replay first, heal with S1' },
  { value: 'explore', label: 'Explore everything' },
  { value: 'replay-only', label: 'Replay only' },
] as const;

interface RunLauncherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  /** Cases to run (preselected); the user can remove some before starting. */
  caseKeys: string[];
  /** Environment (name or id) to preselect; defaults to the first one. */
  defaultEnvironment?: string;
  /** Called with the new run id once the run is created. */
  onStarted: (runId: string) => void;
}

/**
 * Run launcher: cases (preselected), environment, browser, mode, attended toggle and build ref, then `runs.create`.
 * Reusable from the cases list, the case editor and the dashboard.
 */
export function RunLauncherDialog({ open, onOpenChange, projectKey, caseKeys, defaultEnvironment, onStarted }: RunLauncherDialogProps) {
  const envs = trpc.environments.list.useQuery({ projectKey }, { enabled: open });
  const [envId, setEnvId] = useState('');
  const [browser, setBrowser] = useState<(typeof BROWSERS)[number]>('chromium');
  const [mode, setMode] = useState<(typeof MODES)[number]['value']>('replay-heal');
  const [attended, setAttended] = useState(false);
  const [buildRef, setBuildRef] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cases = caseKeys.filter((k) => !removed.includes(k));
  const list = envs.data ?? [];
  useEffect(() => {
    if (envId !== '' || list[0] === undefined) return;
    const preferred = defaultEnvironment !== undefined ? list.find((e) => e.id === defaultEnvironment || e.name === defaultEnvironment) : undefined;
    setEnvId((preferred ?? list[0]).id);
  }, [envId, list, defaultEnvironment]);
  useEffect(() => {
    if (open) setRemoved([]);
  }, [open]);

  const createRun = trpc.runs.create.useMutation();

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const ref = buildRef.trim();
      const run = await createRun.mutateAsync({
        projectKey,
        caseKeys: cases,
        environment: envId,
        browser,
        mode,
        attended,
        ...(ref !== '' ? { buildRef: ref } : {}),
      });
      onOpenChange(false);
      onStarted(run.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run now"
      description={`Run ${cases.length} test case${cases.length === 1 ? '' : 's'}.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || envId === '' || cases.length === 0} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {envs.isError && <Callout tone="danger">Could not load environments: {errorMessage(envs.error)}</Callout>}
        {envs.isSuccess && list.length === 0 && <Callout tone="warning">This project has no environments yet. Add one under Environments first.</Callout>}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg" id="launcher-cases">
            Cases
          </span>
          <ul aria-labelledby="launcher-cases" className="m-0 flex max-h-28 list-none flex-wrap gap-1.5 overflow-auto p-0">
            {cases.map((k) => (
              <li key={k}>
                <Tag mono className="gap-1.5">
                  {k}
                  {cases.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove ${k}`}
                      onClick={() => setRemoved((r) => [...r, k])}
                      className="cursor-pointer border-0 bg-transparent p-0 px-1 text-secondary"
                    >
                      ×
                    </button>
                  )}
                </Tag>
              </li>
            ))}
          </ul>
          {cases.length === 0 && <span className="text-xs text-danger">Select at least one case.</span>}
        </div>
        <Field label="Environment">
          {(id) => (
            <Select id={id} value={envId} onChange={(e) => setEnvId(e.target.value)} disabled={list.length === 0}>
              {list.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Browser">
          {(id) => (
            <Select id={id} value={browser} onChange={(e) => setBrowser(e.target.value as (typeof BROWSERS)[number])}>
              {BROWSERS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Mode">
          {(id) => (
            <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as (typeof MODES)[number]['value'])}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox label="Attended (ask me when System 1 is unsure)" checked={attended} onChange={(e) => setAttended(e.target.checked)} />
        <Field label="Build ref" hint="Commit SHA or build number (optional).">
          {(id) => <Input id={id} mono value={buildRef} onChange={(e) => setBuildRef(e.target.value)} placeholder="e.g. 4f2a9c1" />}
        </Field>
        {error !== null && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}
