import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { ImportWizard } from '../import/ImportWizard';

import { CiSetup } from './CiSetup';
import { CI_CARDS, INTEGRATIONS, TRACKER_PLACEHOLDERS, ago, githubWorkflowSnippet, gitlabSnippet } from './model';
import { RolesOverview } from './RolesOverview';
import { TrackerCards } from './TrackersSection';

import { CodeBlock } from '@/components/app/CodeBlock';
import { Button } from '@/components/ui';
import { trpc } from '@/lib/trpc';

const linkClass = 'mt-auto inline-flex min-h-[44px] items-center self-start rounded-control border border-line-input bg-surface px-4 text-sm font-medium text-fg no-underline';

/**
 * Integrations grid, CI block and the roles box, as on the artboard. GitHub Actions and GitLab CI are live (S-063):
 * "Connected" when an API token has been used from that CI within the last 30 days, and "Configure" shows the snippet.
 */
export function IntegrationsSection() {
  const usage = trpc.tokens.ciUsage.useQuery(undefined, { retry: false });
  const [open, setOpen] = useState<'github' | 'gitlab' | null>(null);
  const [importing, setImporting] = useState(false);
  const server = typeof window === 'undefined' ? 'http://localhost:5317' : window.location.origin;
  const channels = trpc.notifications.channels.list.useQuery();
  const count = (kinds: string[]): number => (channels.data ?? []).filter((c) => kinds.includes(c.kind)).length;
  const slack = count(['slack']);
  const teams = count(['teams']);
  const hooks = count(['webhook']);
  const statusOf = (name: string): string | undefined => {
    if (name === 'Slack · Teams') return slack + teams === 0 ? 'Not connected' : [slack > 0 ? 'Slack connected' : '', teams > 0 ? 'Teams connected' : ''].filter(Boolean).join(' · ');
    if (name === 'Webhooks') return hooks === 0 ? 'Not connected' : `${hooks} outbound`;
    return undefined;
  };
  return (
    <>
      <section aria-label="Integrations" className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        <TrackerCards />
        {INTEGRATIONS.filter((i) => !TRACKER_PLACEHOLDERS.includes(i.name)).map((i) => {
          const provider = (CI_CARDS as Record<string, 'github' | 'gitlab'>)[i.name];
          const u = provider ? usage.data?.[provider] : undefined;
          const live = statusOf(i.name);
          const connected = provider ? u?.connected === true : live !== undefined && live !== 'Not connected';
          const label = provider ? (u?.connected ? 'Connected' : 'Not connected') : (live ?? 'Not connected');
          return (
            <article key={i.name} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 text-sm">
              <div className="flex items-start justify-between gap-2">
                <strong className="text-fg">{i.name}</strong>
                <span className={connected && !provider ? 'text-[13px] font-semibold text-success' : 'text-[13px] text-secondary'}>{label}</span>
              </div>
              <span className="text-[13px] text-secondary">{i.description}</span>
              {u?.lastUsedAt ? <span className="text-[13px] text-secondary">Last CI run {ago(u.lastUsedAt)}</span> : null}
              {provider ? (
                <Button className="mt-auto self-start" aria-expanded={open === provider} onClick={() => setOpen(open === provider ? null : provider)}>
                  {i.action}
                </Button>
              ) : i.name === 'Import' ? (
                <Button className="mt-auto self-start" onClick={() => setImporting(true)}>
                  {i.action}
                </Button>
              ) : live !== undefined ? (
                <Link to="/settings/$section" params={{ section: 'notifications' }} className={linkClass}>
                  {i.action}
                </Link>
              ) : (
                <Button className="mt-auto self-start" disabled aria-label={`${i.action} ${i.name} (available later)`}>
                  {i.action}
                </Button>
              )}
            </article>
          );
        })}
      </section>
      {open === 'github' && <CodeBlock code={githubWorkflowSnippet({ server })} label="GitHub Actions workflow" />}
      {open === 'gitlab' && <CodeBlock code={gitlabSnippet({ server })} label="GitLab CI job" />}
      <ImportWizard open={importing} onOpenChange={setImporting} />
      <CiSetup
        action={
          <Link to="/settings/$section" params={{ section: 'tokens' }} className="inline-flex min-h-[44px] items-center rounded-control border border-line-input bg-surface px-4 text-sm font-medium text-fg no-underline">
            Create API token
          </Link>
        }
      />
      <RolesOverview />
    </>
  );
}
