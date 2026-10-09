import { Link } from '@tanstack/react-router';

import { CiSetup } from './CiSetup';
import { INTEGRATIONS, TRACKER_PLACEHOLDERS } from './model';
import { UsersSection } from './PlaceholderSections';
import { TrackerCards } from './TrackersSection';

import { Button } from '@/components/ui';

/** Integrations grid (placeholders until S-063 to S-065), CI block and the roles box, as on the artboard. */
export function IntegrationsSection() {
  return (
    <>
      <section aria-label="Integrations" className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        <TrackerCards />
        {INTEGRATIONS.filter((i) => !TRACKER_PLACEHOLDERS.includes(i.name)).map((i) => (
          <article key={i.name} className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <strong className="text-fg">{i.name}</strong>
              <span className="text-[13px] text-secondary">Not connected</span>
            </div>
            <span className="text-[13px] text-secondary">{i.description}</span>
            <Button className="mt-auto self-start" disabled aria-label={`${i.action} ${i.name} (available later)`}>
              {i.action}
            </Button>
          </article>
        ))}
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
