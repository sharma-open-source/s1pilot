import { draftOutcomeText, draftSourceText } from './model';

import { Button, Callout, LinkButton, Skeleton, Tag } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const SECTION = 'flex min-w-0 flex-[999_1_520px] flex-col gap-4 rounded-card border border-line bg-surface p-5';

/** Detail of a generated draft: read-only steps grid with Accept / Edit / Discard. */
export function DraftDetail({ id, onDecided }: { id: string; onDecided: (nextId: string | null) => void }) {
  const utils = trpc.useUtils();
  const query = trpc.generate.draft.useQuery(id);
  const refresh = () => {
    void utils.reviews.counts.invalidate();
    void utils.reviews.list.invalidate();
    void utils.generate.draft.invalidate();
    void utils.generate.metrics.invalidate();
    void utils.cases.list.invalidate();
  };
  const accept = trpc.generate.accept.useMutation({
    onSuccess: (out) => {
      refresh();
      onDecided(out.nextId);
    },
  });
  const discard = trpc.generate.discard.useMutation({
    onSuccess: (out) => {
      refresh();
      onDecided(out.nextId);
    },
  });

  if (query.isLoading) {
    return (
      <section aria-label="Draft detail" className={SECTION}>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-36 w-full" />
      </section>
    );
  }
  if (query.isError || !query.data) {
    return (
      <section aria-label="Draft detail" className="min-w-0 flex-[999_1_520px]">
        <Callout tone="danger">Could not load this draft: {errorMessage(query.error)}</Callout>
      </section>
    );
  }
  const d = query.data;
  const pending = d.outcome === null;
  const busy = accept.isPending || discard.isPending;
  const error = accept.error ?? discard.error;
  const editHref = `/p/${encodeURIComponent(d.projectKey)}/cases/${encodeURIComponent(d.caseKey)}`;

  return (
    <section aria-label="Draft detail" className={SECTION}>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 break-words text-lg font-semibold">{d.title}</h2>
        <div className="text-[13px] text-secondary">
          <span className="font-mono">{d.caseKey}</span> · {draftSourceText(d.source)}
          {d.requirementKey !== null && (
            <>
              {' '}
              · for <span className="font-mono">{d.requirementKey}</span>
            </>
          )}
          {d.priority !== null && <> · {d.priority}</>}
          {d.type !== null && <> · {d.type}</>}
        </div>
        {d.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {d.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table aria-label="Generated steps" className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
              <th scope="col" className="w-10 py-2 pr-2 font-medium">
                #
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Action
              </th>
              <th scope="col" className="py-2 font-medium">
                Expected
              </th>
            </tr>
          </thead>
          <tbody>
            {d.steps.map((s, i) => (
              <tr key={i} className="border-t border-divider-row align-top">
                <td className="py-2 pr-2 font-mono text-secondary">{i + 1}</td>
                <td className="py-2 pr-3">{s.action}</td>
                <td className="py-2 text-secondary">{s.expected ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {d.edited && pending && <Callout tone="info-ai">This draft was edited after it was generated. Accepting it counts as accepted with edits.</Callout>}
      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}

      {pending ? (
        <div className="flex flex-wrap gap-2.5 border-t border-divider-row pt-3">
          <Button variant="primary" disabled={busy} onClick={() => accept.mutate({ id })}>
            Accept
          </Button>
          <LinkButton to={editHref} variant="secondary">
            Edit
          </LinkButton>
          <Button variant="danger-outline" disabled={busy} onClick={() => discard.mutate({ id })}>
            Discard
          </Button>
        </div>
      ) : (
        <div className="border-t border-divider-row pt-3">
          <Callout tone={d.outcome === 'discarded' ? 'warning' : 'success'}>
            {draftOutcomeText(d.outcome)}
            {d.resolvedAt ? ` on ${new Date(d.resolvedAt).toLocaleString()}` : ''}.
          </Callout>
        </div>
      )}
    </section>
  );
}
