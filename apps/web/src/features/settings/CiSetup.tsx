import { useState, type ReactNode } from 'react';

import { ciCommand } from './model';

import { CodeBlock } from '@/components/app/CodeBlock';
import { Card, Field, Select } from '@/components/ui';
import { trpc } from '@/lib/trpc';

/**
 * "Run from CI or terminal": the CLI command prefilled with this server's URL and the selected plan.
 * The command only references `$S1P_TOKEN`; a token value is never put into it.
 */
export function CiSetup({ action }: { action?: ReactNode }) {
  const projects = trpc.projects.list.useQuery();
  const [picked, setPicked] = useState<string>('');
  const projectKey = picked || projects.data?.[0]?.key || '';
  const plans = trpc.plans.list.useQuery({ projectKey }, { enabled: projectKey !== '' });
  const envs = trpc.environments.list.useQuery({ projectKey }, { enabled: projectKey !== '' });
  const [plan, setPlan] = useState('');
  const planName = plans.data?.some((p) => p.name === plan) ? plan : (plans.data?.[0]?.name ?? '');
  const server = typeof window === 'undefined' ? 'http://localhost:5317' : window.location.origin;
  const code = ciCommand({ server, plan: planName, env: envs.data?.[0]?.name });

  return (
    <Card aria-label="CI setup" className="flex flex-col gap-3 p-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-fg">Run from CI or terminal</h2>
        {action}
      </div>
      {(projects.data?.length ?? 0) > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          <Field label="Project">
            {(id) => (
              <Select id={id} value={projectKey} onChange={(e) => setPicked(e.target.value)}>
                {projects.data?.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Plan" hint={plans.data?.length === 0 ? 'No plans yet. Create one under Test plans.' : undefined}>
            {(id) => (
              <Select id={id} value={planName} onChange={(e) => setPlan(e.target.value)} disabled={(plans.data?.length ?? 0) === 0}>
                {plans.data?.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
      <CodeBlock code={code} label="CLI command" />
      <div className="text-[13px] text-secondary">
        Exit code is non-zero when exit criteria fail. Results appear in Reports with the commit and build reference.
      </div>
    </Card>
  );
}
