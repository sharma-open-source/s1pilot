import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { CiSetup } from './CiSetup';
import { CI_CARDS, INTEGRATIONS, ago, githubWorkflowSnippet, gitlabSnippet } from './model';
import { UsersSection } from './PlaceholderSections';

import { CodeBlock } from '@/components/app/CodeBlock';
import { Button } from '@/components/ui';
import { trpc } from '@/lib/trpc';

/**
 * Integrations grid, CI block and the roles box, as on the artboard. GitHub Actions and GitLab CI are live (S-063):
 * "Connected" when an API token has been used from that CI within the last 30 days, and "Configure" shows the snippet.
 */
export function IntegrationsSection() {
  const usage = trpc.tokens.ciUsage.useQuery(undefined, { retry: false });
  const [open, setOpen] = useState<'github' | 'gitlab' | null>(null);
  const server = typeof window === 'undefined' ? 'http://localhost:5317' : window.location.origin;
  return (
    <>
      <section aria-label="Integrations" className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        {INTEGRATIONS.map((i) => {
          const provider = (CI_CARDS as Record<string, 'github' | 'gitlab'>)[i.name];
          const u = provider ? usage.data?.[provider] : undefined;
          return (
            <article key={i.name} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 text-sm">
              <div className="flex items-start justify-between gap-2">
                <strong className="text-fg">{i.name}</strong>
                <span className="text-[13px] text-secondary">{u?.connected ? 'Connected' : 'Not connected'}</span>
              </div>
              <span className="text-[13px] text-secondary">{i.description}</span>
              {u?.lastUsedAt ? <span className="text-[13px] text-secondary">Last CI run {ago(u.lastUsedAt)}</span> : null}
              {provider ? (
                <Button className="mt-auto self-start" aria-expanded={open === provider} onClick={() => setOpen(open === provider ? null : provider)}>
                  {i.action}
                </Button>
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
      <CiSetup
        action={
          <Link to="/settings/$section" params={{ section: 'tokens' }} className="inline-flex min-h-[44px] items-center rounded-control border border-line-input bg-surface px-4 text-sm font-medium text-fg no-underline">
            Create API token
          </Link>
        }
      />
      <UsersSection />
    </>
  );
}
