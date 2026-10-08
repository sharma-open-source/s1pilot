import * as Popover from '@radix-ui/react-popover';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { LinkButton } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import type { ModelRow, ModelsStatus, NavProject, WorkspaceBadges } from '@/lib/nav-data';

export interface NavItemDef {
  id: string;
  label: string;
  /** Route for the given project key (`null` when no project is selected). */
  href: (key: string | null) => string;
  /** Whether `pathname` belongs to this item. */
  isActive: (pathname: string) => boolean;
  badge?: 'live' | 'review';
}

const under = (base: string) => (pathname: string) => pathname === base || pathname.startsWith(`${base}/`);
const projectPath = (segment: string) => (key: string | null) => (key === null ? '/projects/new' : `/p/${key}/${segment}`);
const projectActive = (segment: string) => (pathname: string) => /^\/p\/[^/]+\//.test(pathname) && under(`/p/${pathname.split('/')[2]}/${segment}`)(pathname);

/** The 12 nav items in wireframe order (design.md 3.1). */
export const NAV_ITEMS: NavItemDef[] = [
  { id: 'dashboard', label: 'Dashboard', href: () => '/', isActive: (p) => p === '/' },
  { id: 'setup', label: 'Project setup', href: () => '/projects/new', isActive: under('/projects') },
  { id: 'environments', label: 'Environments', href: projectPath('environments'), isActive: projectActive('environments') },
  { id: 'cases', label: 'Test cases', href: projectPath('cases'), isActive: projectActive('cases') },
  { id: 'plans', label: 'Test plans', href: projectPath('plans'), isActive: projectActive('plans') },
  { id: 'runs', label: 'Runs', href: projectPath('runs'), isActive: projectActive('runs'), badge: 'live' },
  { id: 'manual', label: 'Manual testing', href: projectPath('manual'), isActive: projectActive('manual') },
  { id: 'reports', label: 'Reports', href: projectPath('reports'), isActive: projectActive('reports') },
  { id: 'review', label: 'Review queue', href: projectPath('review'), isActive: projectActive('review'), badge: 'review' },
  { id: 'defects', label: 'Defects', href: projectPath('defects'), isActive: projectActive('defects') },
  { id: 'analytics', label: 'Analytics', href: (k) => (k === null ? '/projects/new' : `/p/${k}/analytics/quality`), isActive: projectActive('analytics') },
  { id: 'settings', label: 'Settings', href: () => '/settings/general', isActive: under('/settings') },
];

export interface NavProps {
  pathname: string;
  projects: NavProject[];
  projectsLoading?: boolean;
  /** Key of the selected project, or `null`. */
  currentProjectKey: string | null;
  onSelectProject?: (key: string) => void;
  badges: WorkspaceBadges;
  models: ModelsStatus;
}

function badgeText(item: NavItemDef, badges: WorkspaceBadges): string {
  if (item.badge === 'live') return badges.liveRuns > 0 ? `${badges.liveRuns} live` : '';
  if (item.badge === 'review') return badges.reviewCount > 0 ? String(badges.reviewCount) : '';
  return '';
}

function ProjectSwitcher({
  projects,
  loading,
  current,
  onSelect,
}: {
  projects: NavProject[];
  loading: boolean;
  current: NavProject | null;
  onSelect?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Switch project"
          className="flex min-h-[44px] items-center justify-between rounded-control border border-line bg-surface-subtle px-3 py-2 text-left text-sm text-fg"
        >
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[11px] uppercase tracking-[0.06em] text-muted">Project</span>
            <span className="truncate font-semibold">
              {current !== null ? `${current.key} · ${current.name}` : loading ? 'Loading…' : 'No project'}
            </span>
          </span>
          <ChevronDown size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 flex w-[var(--radix-popover-trigger-width)] min-w-[220px] flex-col gap-1 rounded-control border border-line bg-surface p-2"
        >
          {loading ? (
            <Skeleton className="h-9 w-full" />
          ) : projects.length === 0 ? (
            <p className="m-0 px-2 py-1.5 text-[13px] text-secondary">No projects yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {projects.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    aria-current={p.key === current?.key ? 'true' : undefined}
                    onClick={() => {
                      onSelect?.(p.key);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex min-h-[40px] w-full items-center rounded-tag px-2 text-left text-sm text-strong-2',
                      p.key === current?.key && 'bg-primary-soft font-semibold text-primary-text',
                    )}
                  >
                    <span className="font-mono text-xs">{p.key}</span>
                    <span className="ml-2 truncate">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <LinkButton to="/projects/new" variant="secondary" size="sm" onClick={() => setOpen(false)}>
            New project
          </LinkButton>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelLine({ label, row }: { label: 'S1' | 'S2'; row: ModelRow | null }) {
  const reachable = row?.reachable ?? 'unknown';
  const dot = reachable === true ? 'bg-success-dot' : reachable === false ? 'bg-danger' : 'bg-line-dashed-strong';
  const state = reachable === true ? 'reachable' : reachable === false ? 'unreachable' : 'status unknown';
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-pill', dot)} />
      <span className="min-w-0">
        <strong className="text-fg">{label}</strong>{' '}
        {row !== null ? (
          <span className="font-mono">
            {row.model}
            {row.endpoint !== '' && ` · ${row.endpoint}`}
          </span>
        ) : (
          <span>not configured</span>
        )}
        <span className="sr-only"> ({state})</span>
      </span>
    </div>
  );
}

/** Left navigation: logo, project switcher, 12 items with badges, and the Models status box. */
export function Nav({ pathname, projects, projectsLoading = false, currentProjectKey, onSelectProject, badges, models }: NavProps) {
  const current = projects.find((p) => p.key === currentProjectKey) ?? null;
  const key = current?.key ?? currentProjectKey;
  return (
    <nav
      aria-label="Main"
      className="box-border flex w-full flex-col gap-[22px] border-b border-line bg-surface px-3.5 py-5 text-fg min-[640px]:h-full min-[640px]:min-h-screenmin-[640px]:border-b-0 min-[640px]:border-r"
    >
      <div className="flex items-center gap-2.5 px-1.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-tag bg-ink font-mono text-[13px] font-semibold text-white">S1</div>
        <div className="font-mono text-base font-semibold">s1-pilot</div>
      </div>
      <ProjectSwitcher projects={projects} loading={projectsLoading} current={current} onSelect={onSelectProject} />
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(pathname);
          const badge = badgeText(item, badges);
          return (
            <li key={item.id}>
              <Link
                to={item.href(key) as never}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[40px] items-center justify-between rounded-tag px-3 text-sm no-underline',
                  active ? 'bg-primary-soft font-semibold text-primary-text' : 'text-strong-2',
                )}
              >
                {item.label}
                {badge !== '' && <span className="font-mono text-xs text-warning">{badge}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
      <section
        aria-label="Models"
        className="mt-auto flex flex-col gap-2 rounded-control border border-dashed border-line-dashed p-3 text-xs text-secondary"
      >
        <div className="text-[11px] uppercase tracking-[0.06em] text-muted">Models</div>
        <ModelLine label="S1" row={models.s1} />
        <ModelLine label="S2" row={models.s2} />
      </section>
    </nav>
  );
}
