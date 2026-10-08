import type { ReactNode } from 'react';

import { EmptyState } from '@/components/ui/misc';

/** Page header: eyebrow or breadcrumb above the h1 on the left, actions on the right (primary rightmost). */
export function PageHeader({ eyebrow, title, actions }: { eyebrow?: ReactNode; title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow !== undefined && <div className="text-[13px] text-muted">{eyebrow}</div>}
        <h1 className="text-[28px] font-semibold text-fg">{title}</h1>
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

/** Route skeleton used until the owning spec builds the page. */
export function PlaceholderPage({ title, spec, eyebrow }: { title: string; spec: string; eyebrow?: ReactNode }) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} />
      <EmptyState>This screen is built in {spec}.</EmptyState>
    </>
  );
}
