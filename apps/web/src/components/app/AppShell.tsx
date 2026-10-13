import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { Nav } from './Nav';

import { UserMenu } from '@/features/auth/UserMenu';
import { EMPTY_MODELS, useModelsStatus, useProjects, useWorkspaceBadges } from '@/lib/nav-data';


const STORAGE_KEY = 's1pilot.project';

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* storage unavailable: selection just isn't remembered */
  }
}

/** Project key from a `/p/:key/...` path, else `null`. */
export function projectKeyFromPath(pathname: string): string | null {
  const m = /^\/p\/([^/]+)(?:\/|$)/.exec(pathname);
  return m?.[1] !== undefined ? decodeURIComponent(m[1]) : null;
}

/** App shell: nav on the left (stacked above on narrow screens) and the page in `<main>`. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const projects = useProjects();
  const badges = useWorkspaceBadges();
  const [chosen, setChosen] = useState<string | null>(readStored);

  const list = projects.data ?? [];
  const fromPath = projectKeyFromPath(pathname);
  const currentKey = fromPath ?? (chosen !== null && list.some((p) => p.key === chosen) ? chosen : (list[0]?.key ?? null));
  const models = useModelsStatus(currentKey);

  return (
    <div className="flex min-h-screen flex-wrap bg-app">
      <div className="w-full flex-[1_1_240px] min-[640px]:max-w-[260px]">
        <Nav
          pathname={pathname}
          projects={list}
          projectsLoading={projects.isLoading}
          currentProjectKey={currentKey}
          onSelectProject={(key) => {
            store(key);
            setChosen(key);
            void navigate({ to: `/p/${key}/cases` as never });
          }}
          badges={badges}
          models={models.data ?? EMPTY_MODELS}
        />
        <UserMenu />
      </div>
      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-6 px-4 py-6 min-[640px]:px-9 min-[640px]:py-7">{children}</main>
    </div>
  );
}
