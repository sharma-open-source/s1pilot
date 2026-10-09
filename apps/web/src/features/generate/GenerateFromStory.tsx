import { useState } from 'react';

import { Button, Callout, Dialog, Field, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const NO_S2 = 'Generate from story needs a System 2 model. Configure one in the model settings.';

/** Count options offered by the dialog. */
const COUNTS = [1, 2, 3, 5, 8, 10] as const;

/**
 * "Generate from story · S2" button and dialog (Test cases header). Disabled with an explanatory tooltip when the
 * project has no System 2 model. Generated cases arrive as drafts in the review queue.
 */
export function GenerateFromStory({ projectKey, suiteId, navigate }: { projectKey: string; suiteId?: string; navigate: (to: string) => void }) {
  const utils = trpc.useUtils();
  const status = trpc.generate.status.useQuery({ projectKey });
  const [open, setOpen] = useState(false);
  const [story, setStory] = useState('');
  const [requirement, setRequirement] = useState('');
  const [count, setCount] = useState(3);
  const requirements = trpc.requirements.list.useQuery({ projectKey }, { enabled: open });
  const generate = trpc.generate.fromStory.useMutation({
    onSuccess: () => {
      void utils.cases.list.invalidate();
      void utils.reviews.counts.invalidate();
      void utils.reviews.list.invalidate();
      void utils.generate.metrics.invalidate();
      void utils.requirements.list.invalidate();
    },
  });
  const configured = status.data?.s2Configured === true;
  const created = generate.data?.cases.length ?? 0;

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) generate.reset();
  };

  return (
    <>
      <Button disabled={!configured} title={configured ? undefined : NO_S2} onClick={() => setOpen(true)}>
        Generate from story · S2
      </Button>
      <Dialog
        open={open}
        onOpenChange={close}
        title="Generate from story"
        description="System 2 drafts test cases from a user story or acceptance criteria. Drafts are never run until you accept them in the review queue."
        footer={
          generate.isSuccess ? (
            <>
              <Button variant="secondary" onClick={() => close(false)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => navigate(`/p/${encodeURIComponent(projectKey)}/review?tab=drafts`)}>
                Review drafts
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={generate.isPending || story.trim() === ''}
                onClick={() =>
                  generate.mutate({
                    projectKey,
                    storyText: story,
                    count,
                    ...(requirement !== '' ? { requirementKey: requirement } : {}),
                    ...(suiteId !== undefined ? { suiteId } : {}),
                  })
                }
              >
                {generate.isPending ? 'Generating…' : 'Generate drafts'}
              </Button>
            </>
          )
        }
      >
        {generate.isSuccess ? (
          <Callout tone="success">
            {created} draft {created === 1 ? 'test case was' : 'test cases were'} added to the review queue.
          </Callout>
        ) : (
          <div className="flex flex-col gap-3.5">
            <Field label="User story or acceptance criteria" hint="Paste the story as written. Do not include passwords or personal data.">
              {(id) => (
                <Textarea
                  id={id}
                  rows={6}
                  value={story}
                  placeholder="As a shopper I can add products to my cart and see the item count in the header."
                  onChange={(e) => setStory(e.target.value)}
                />
              )}
            </Field>
            <Field label="Requirement (optional)">
              {(id) => (
                <Select id={id} value={requirement} onChange={(e) => setRequirement(e.target.value)}>
                  <option value="">None</option>
                  {(requirements.data ?? []).map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.key} · {r.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Number of test cases">
              {(id) => (
                <Select id={id} value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
                  {COUNTS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {generate.isError && <Callout tone="danger">{errorMessage(generate.error)}</Callout>}
          </div>
        )}
      </Dialog>
    </>
  );
}
