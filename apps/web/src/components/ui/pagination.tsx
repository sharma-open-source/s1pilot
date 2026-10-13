import { Button } from './button';

import { cn } from '@/lib/cn';

/** Default rows per page for list tables. */
export const DEFAULT_PAGE_SIZE = 25;

/** A `page` URL search param as a page number > 1, or undefined (page 1 stays out of the URL). */
export function parsePageParam(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 1 ? n : undefined;
}

/** Number of pages for `total` rows (always at least 1). */
export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Rows of 1-based `page` from an in-memory list; `page` is clamped to the last page. */
export function paginate<T>(
  rows: readonly T[],
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
): { items: T[]; page: number; pageCount: number; total: number } {
  const pageCount = pageCountOf(rows.length, pageSize);
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * pageSize;
  return {
    items: rows.slice(start, start + pageSize),
    page: current,
    pageCount,
    total: rows.length,
  };
}

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  pageCount: number;
  /** Rows shown on this page. */
  shown: number;
  /** Rows across all pages. */
  total: number;
  onPageChange: (page: number) => void;
  /** Hide the bar when everything fits on one page (default false: the bar always shows the count). */
  hideSingle?: boolean;
  className?: string;
}

/** Table footer: "Showing n of total" plus Previous / "Page x of y" / Next (wireframe 03 list footer). */
export function Pagination({
  page,
  pageCount,
  shown,
  total,
  onPageChange,
  hideSingle = false,
  className,
}: PaginationProps) {
  if (hideSingle && pageCount <= 1) return null;
  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-wrap items-center justify-between gap-2.5 border-t border-divider px-4 py-3 text-[13px] text-secondary',
        className,
      )}
    >
      <span>
        Showing {shown} of {total}
      </span>
      <span className="flex items-center gap-2.5">
        <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <span>
          Page {page} of {pageCount}
        </span>
        <Button size="sm" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </span>
    </nav>
  );
}
