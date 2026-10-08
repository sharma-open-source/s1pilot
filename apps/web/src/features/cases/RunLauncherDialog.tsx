import { useEffect, useState } from 'react';

import { Button, Callout, Dialog, Field, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const MODES = [
  { value: 'replay-heal', label: 'Replay, heal with AI when needed' },
  { value: 'explore', label: 'Explore with AI' },
  { value: 'replay-only', label: 'Replay only' },
] as const;

interface RunLauncherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  caseKeys: string[];
  /** Called with the new run id once the run is created. */
  onStarted: (runId: string) => void;
}

/** Run launcher: pick environment, browser and mode, then create a run for the selected cases. */
export function RunLauncherDialog({ open, onOpenChange, projectKey, caseKeys, onStarted }: RunLauncherDialogProps) {
  const envs = trpc.environments.list.useQuery({ projectKey }, { enabled: open });
  const [envId, setEnvId] = useState('');
  const [browser, setBrowser] = useState<(typeof BROWSERS)[number]>('chromium');
  const [mode, setMode] = useState<(typeof MODES)[number]['value']>('replay-heal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = envs.data ?? [];
  useEffect(() => {
    if (envId === '' && list[0] !== undefined) setEnvId(list[0].id);
  }, [envId, list]);

  const createRun = trpc.runs.create.useMutation();

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await createRun.mutateAsync({ projectKey, caseKeys, environment: envId, browser, mode });
      const runId = run.id;
      onOpenChange(false);
      onStarted(runId);
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
      description={`Run ${caseKeys.length} selected test case${caseKeys.length === 1 ? '' : 's'}.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || envId === ''} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {envs.isError && <Callout tone="danger">Could not load environments: {errorMessage(envs.error)}</Callout>}
        {envs.isSuccess && list.length === 0 && <Callout tone="warning">This project has no environments yet. Add one under Environments first.</Callout>}
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
        {error !== null && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}
