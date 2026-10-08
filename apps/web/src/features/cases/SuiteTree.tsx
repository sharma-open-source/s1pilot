import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import {
  Button,
  Callout,
  ConfirmDialog,
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Skeleton,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

export type SuiteNode = RouterOutputs['suites']['tree']['tree'][number];

/** Ids from the root down to `target` (inclusive), or `[]` when it is not in the tree. */
export function pathToSuite(nodes: SuiteNode[], target: string | undefined): string[] {
  if (target === undefined) return [];
  for (const n of nodes) {
    if (n.id === target) return [n.id];
    const sub = pathToSuite(n.children, target);
    if (sub.length > 0) return [n.id, ...sub];
  }
  return [];
}

/** Flattens the tree depth-first with the display depth, for pickers (`Move to...`). */
export function flattenSuites(nodes: SuiteNode[], depth = 0): Array<{ id: string; name: string; depth: number }> {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flattenSuites(n.children, depth + 1)]);
}

/** Finds a node by id. */
export function findSuite(nodes: SuiteNode[], id: string | undefined): SuiteNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const sub = findSuite(n.children, id);
    if (sub) return sub;
  }
  return undefined;
}

const rowBase = 'flex min-h-[40px] items-center rounded-tag text-sm';

interface InlineNameProps {
  label: string;
  initial?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  busy: boolean;
}

/** Inline text input committed with Enter (or the Save button) and cancelled with Escape. */
function InlineName({ label, initial = '', onSubmit, onCancel, busy }: InlineNameProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const commit = () => {
    const name = value.trim();
    if (name !== '') onSubmit(name);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="flex items-center gap-1.5 py-1">
      <Input
        ref={ref}
        aria-label={label}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        className="h-[40px] min-w-0 flex-1"
      />
      <Button size="sm" variant="primary" disabled={busy || value.trim() === ''} onClick={commit} aria-label={`Save ${label}`}>
        Save
      </Button>
    </div>
  );
}

interface SuiteTreeProps {
  projectKey: string;
  /** Selected suite id (`undefined` = All cases). */
  activeSuite: string | undefined;
  hrefFor: (suiteId: string | undefined) => string;
  onSelect: (suiteId: string | undefined) => void;
  /** In-app navigation for the Library links. */
  onNavigate: (to: string) => void;
  className?: string;
}

/**
 * Suites aside: "All cases" plus nested suites with expand toggles and counts, an inline "+" add form,
 * a per-row actions menu (add sub-suite, rename, delete) and the Library links.
 */
export function SuiteTree({ projectKey, activeSuite, hrefFor, onSelect, onNavigate, className }: SuiteTreeProps) {
  const utils = trpc.useUtils();
  const tree = trpc.suites.tree.useQuery({ projectKey });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<{ parentId?: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SuiteNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodes = tree.data?.tree;
  const activePath = useMemo(() => pathToSuite(nodes ?? [], activeSuite), [nodes, activeSuite]);
  useEffect(() => {
    if (activePath.length > 1) setExpanded((prev) => new Set([...prev, ...activePath.slice(0, -1)]));
  }, [activePath]);

  const refresh = async () => {
    await Promise.all([utils.suites.tree.invalidate(), utils.cases.list.invalidate()]);
  };
  const fail = (err: unknown) => setError(errorMessage(err));

  const create = trpc.suites.create.useMutation({
    onSuccess: async (_s, vars) => {
      setAdding(null);
      setError(null);
      if (vars.parentId !== undefined) setExpanded((prev) => new Set(prev).add(vars.parentId as string));
      await refresh();
    },
    onError: fail,
  });
  const rename = trpc.suites.rename.useMutation({
    onSuccess: async () => {
      setRenaming(null);
      setError(null);
      await refresh();
    },
    onError: fail,
  });
  const remove = trpc.suites.delete.useMutation({
    onSuccess: async (_r, vars) => {
      setError(null);
      if (activePath.includes(vars.id)) onSelect(undefined);
      await refresh();
    },
    onError: fail,
  });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const link = (suiteId: string | undefined) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onSelect(suiteId);
  };

  const renderNode = (n: SuiteNode, depth: number) => {
    const active = n.id === activeSuite;
    const open = expanded.has(n.id);
    return (
      <li key={n.id} className="list-none">
        {renaming === n.id ? (
          <InlineName
            label={`Name for ${n.name}`}
            initial={n.name}
            busy={rename.isPending}
            onSubmit={(name) => rename.mutate({ id: n.id, name })}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <div
            className={cn(rowBase, active ? 'bg-primary-soft font-semibold text-primary-text' : 'text-fg')}
            style={{ paddingLeft: depth * 16 }}
          >
            {n.children.length > 0 ? (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${n.name}`}
                onClick={() => toggle(n.id)}
                className="flex h-[40px] w-7 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-inherit"
              >
                {open ? '▾' : '▸'}
              </button>
            ) : (
              <span className="w-7 shrink-0" aria-hidden="true" />
            )}
            <a
              href={hrefFor(n.id)}
              onClick={link(n.id)}
              aria-current={active ? 'page' : undefined}
              className="flex min-h-[40px] min-w-0 flex-1 items-center justify-between gap-2 py-1 text-inherit no-underline"
            >
              <span className="truncate">{n.name}</span>
              <span className={cn('font-mono text-[13px]', active ? '' : 'text-muted')}>{n.totalCount}</span>
            </a>
            <DropdownMenu>
              <DropdownTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${n.name}`}
                  className="flex h-[40px] w-9 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-muted"
                >
                  ⋯
                </button>
              </DropdownTrigger>
              <DropdownContent align="end">
                <DropdownItem onSelect={() => setAdding({ parentId: n.id })}>Add sub-suite</DropdownItem>
                <DropdownItem onSelect={() => setRenaming(n.id)}>Rename</DropdownItem>
                <DropdownItem className="text-danger" onSelect={() => setDeleting(n)}>
                  Delete
                </DropdownItem>
              </DropdownContent>
            </DropdownMenu>
          </div>
        )}
        {adding?.parentId === n.id && (
          <div style={{ paddingLeft: (depth + 1) * 16 + 28 }}>
            <InlineName
              label={`New sub-suite of ${n.name}`}
              busy={create.isPending}
              onSubmit={(name) => create.mutate({ projectKey, name, parentId: n.id })}
              onCancel={() => setAdding(null)}
            />
          </div>
        )}
        {open && n.children.length > 0 && <ul className="m-0 flex flex-col gap-0.5 p-0">{n.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  const allActive = activeSuite === undefined;
  return (
    <aside
      aria-label="Suites"
      className={cn('flex flex-col gap-1 rounded-card border border-line bg-surface p-3.5 text-sm', className)}
    >
      <div className="flex items-center justify-between px-1.5 pb-2.5 pt-1">
        <span className="font-semibold text-fg">Suites</span>
        <button
          type="button"
          aria-label="Add suite"
          onClick={() => setAdding({})}
          className="flex h-[44px] w-[44px] items-center justify-center rounded-tag border border-line-input bg-surface text-base text-fg"
        >
          +
        </button>
      </div>
      {adding !== null && adding.parentId === undefined && (
        <InlineName
          label="New suite name"
          busy={create.isPending}
          onSubmit={(name) => create.mutate({ projectKey, name })}
          onCancel={() => setAdding(null)}
        />
      )}
      {error !== null && <Callout tone="danger">{error}</Callout>}
      {tree.isLoading && (
        <div className="flex flex-col gap-2" aria-label="Loading suites">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      )}
      {tree.isError && <Callout tone="danger">Could not load suites: {errorMessage(tree.error)}</Callout>}
      {tree.data !== undefined && (
        <ul className="m-0 flex flex-col gap-0.5 p-0">
          <li className="list-none">
            <a
              href={hrefFor(undefined)}
              onClick={link(undefined)}
              aria-current={allActive ? 'page' : undefined}
              className={cn(
                rowBase,
                'min-h-[40px] justify-between px-2.5 no-underline',
                allActive ? 'bg-primary-soft font-semibold text-primary-text' : 'text-fg',
              )}
            >
              All cases
              <span className={cn('font-mono text-[13px]', allActive ? '' : 'text-muted')}>{tree.data.totalCases}</span>
            </a>
          </li>
          {tree.data.tree.map((n) => renderNode(n, 0))}
        </ul>
      )}
      <div className="mt-3 border-t border-divider px-1.5 pb-1 pt-2.5 text-xs uppercase tracking-[0.06em] text-muted">Library</div>
      {(
        [
          ['Shared steps & flows', 'shared-steps'],
          ['Test data sets', 'test-data'],
          ['Requirements', 'requirements'],
        ] as const
      ).map(([label, slug]) => (
        <a
          key={slug}
          href={`/p/${encodeURIComponent(projectKey)}/library/${slug}`}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onNavigate(`/p/${encodeURIComponent(projectKey)}/library/${slug}`);
          }}
          className="flex min-h-[40px] items-center rounded-tag px-2.5 text-fg no-underline hover:bg-surface-subtle"
        >
          {label}
        </a>
      ))}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        tone="danger"
        title={`Delete suite "${deleting?.name ?? ''}"?`}
        description={
          deleting !== undefined && deleting !== null && deleting.totalCount > 0
            ? `This deletes the suite and its sub-suites. Its ${deleting.totalCount} test case${deleting.totalCount === 1 ? '' : 's'} are kept and become unsorted.`
            : 'This deletes the suite and its sub-suites. It contains no test cases.'
        }
        confirmLabel="Delete suite"
        onConfirm={() => {
          if (deleting !== null) remove.mutate({ id: deleting.id, moveCasesTo: null });
        }}
      />
    </aside>
  );
}
