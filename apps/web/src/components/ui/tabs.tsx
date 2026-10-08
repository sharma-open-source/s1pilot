import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface TabItem {
  label: ReactNode;
  /** Route path; active when it equals the current pathname (or a prefix of it when `prefix`). */
  to: string;
  /** Match nested paths too. */
  prefix?: boolean;
}

/** Underline tabs rendered as router links; the active one has `aria-current="page"`. */
export function Tabs({ items, 'aria-label': ariaLabel, className }: { items: TabItem[]; 'aria-label': string; className?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label={ariaLabel} className={cn('flex flex-wrap border-b border-line', className)}>
      {items.map((t) => {
        const active = pathname === t.to || (t.prefix === true && pathname.startsWith(`${t.to}/`));
        return (
          <Link
            key={t.to}
            to={t.to as never}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'min-h-[44px] -mb-px inline-flex items-center border-b-2 px-3.5 py-2.5 text-sm no-underline',
              active ? 'border-ink font-semibold text-fg' : 'border-transparent text-secondary',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
