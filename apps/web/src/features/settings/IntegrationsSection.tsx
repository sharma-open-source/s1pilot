import { Link } from '@tanstack/react-router';

import { CiSetup } from './CiSetup';
import { INTEGRATIONS } from './model';
import { UsersSection } from './PlaceholderSections';

import { Button } from '@/components/ui';
import { trpc } from '@/lib/trpc';

const linkClass = 'mt-auto inline-flex min-h-[44px] items-center self-start rounded-control border border-line-input bg-surface px-4 text-sm font-medium text-fg no-underline';

/** Integrations grid (placeholders until S-063 to S-065), CI block and the roles box, as on the artboard. */
export function IntegrationsSection() {
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
        {INTEGRATIONS.map((i) => {
          const live = statusOf(i.name);
          return (
          <article key={i.name} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <strong className="text-fg">{i.name}</strong>
              <span className={live !== undefined && live !== 'Not connected' ? 'text-[13px] font-semibold text-success' : 'text-[13px] text-secondary'}>{live ?? 'Not connected'}</span>
            </div>
            <span className="text-[13px] text-secondary">{i.description}</span>
            {live !== undefined ? (
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
