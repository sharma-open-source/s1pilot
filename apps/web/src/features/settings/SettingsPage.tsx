import { Link, Navigate } from '@tanstack/react-router';

import { IntegrationsSection } from './IntegrationsSection';
import { parseSection, SETTINGS_SECTIONS, type SettingsSlug } from './model';
import { ModelsSection } from './ModelsSection';
import { NotificationsSection } from './NotificationsSection';
import { AuditSection, UsersSection } from './PlaceholderSections';
import { TokensSection } from './TokensSection';
import { DataSection, GeneralSection, WorkersSection } from './WorkspaceSections';

import { PageHeader } from '@/components/app/PageHeader';
import { cn } from '@/lib/cn';

function SectionBody({ slug }: { slug: SettingsSlug }) {
  switch (slug) {
    case 'general':
      return <GeneralSection />;
    case 'models':
      return <ModelsSection />;
    case 'integrations':
      return <IntegrationsSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'users':
      return <UsersSection />;
    case 'data':
      return <DataSection />;
    case 'workers':
      return <WorkersSection />;
    case 'tokens':
      return <TokensSection />;
    case 'audit':
      return <AuditSection />;
  }
}

/** `/settings/:section`: eyebrow + h1, vertical section nav (stacks above the content on narrow screens) and the section. */
export function SettingsPage({ section }: { section: string }) {
  const slug = parseSection(section);
  if (slug === undefined) return <Navigate to="/settings/$section" params={{ section: 'general' }} replace />;
  return (
    <>
      <PageHeader eyebrow="Workspace" title="Settings" />
      <div className="flex flex-wrap items-start gap-5">
        <nav aria-label="Settings sections" className="flex max-w-[240px] flex-[1_1_200px] flex-col gap-0.5 text-sm max-[520px]:max-w-none">
          {SETTINGS_SECTIONS.map((s) => (
            <Link
              key={s.slug}
              to="/settings/$section"
              params={{ section: s.slug }}
              aria-current={s.slug === slug ? 'page' : undefined}
              className={cn(
                'flex min-h-[44px] items-center gap-2 rounded-tag px-3 no-underline',
                s.slug === slug ? 'bg-primary-soft font-semibold text-primary-text' : 'text-fg hover:bg-surface-muted',
              )}
            >
              {s.label}
              {'badge' in s && <span className="text-[11px] font-normal text-secondary">{s.badge}</span>}
            </Link>
          ))}
        </nav>
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          <SectionBody slug={slug} />
        </div>
      </div>
    </>
  );
}
