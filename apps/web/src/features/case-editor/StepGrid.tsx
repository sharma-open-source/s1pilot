import type { Assertion } from '@s1pilot/domain';
import { Copy, GripVertical, Trash2, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { ActionField, type SharedOption } from './ActionField';
import { AssertionDialog } from './AssertionDialog';
import { blankStep, checkTags, duplicateStep, moveStep, removeStep, type DraftStep } from './model';

import { Button, Input, Tag } from '@/components/ui';
import { cn } from '@/lib/cn';

interface StepGridProps {
  steps: DraftStep[];
  /** Parameter names available for `{param}` chips and autocomplete. */
  params: string[];
  /** Shared steps for `@` autocomplete and for rendering shared-step rows. */
  shared: SharedOption[];
  onChange: (steps: DraftStep[]) => void;
  onInsertShared: () => void;
  /** Opens the recorder to add steps after the last one (S-060). Absent: the button is disabled. */
  onRecord?: () => void;
}

const HEADERS = ['#', 'Action (plain language)', 'Expected result', 'Checks'];

/** Editable step table: action, expected result and checks per row, with reorder, duplicate and delete. */
export function StepGrid({ steps, params, shared, onChange, onInsertShared, onRecord }: StepGridProps) {
  const [checkFor, setCheckFor] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const dragFrom = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const focusHandle = useRef<string | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());

  useLayoutEffect(() => {
    if (focusHandle.current !== null) {
      handles.current.get(focusHandle.current)?.focus();
      focusHandle.current = null;
    }
  });

  const patch = (index: number, change: Partial<DraftStep>) =>
    onChange(steps.map((s, i) => (i === index ? { ...s, ...change } : s)));

  const move = (from: number, to: number) => {
    const next = moveStep(steps, from, to);
    if (next === steps) return;
    const uid = steps[from]?.uid;
    if (uid !== undefined) focusHandle.current = uid;
    onChange(next);
    setAnnounce(`Step moved to position ${Math.max(0, Math.min(steps.length - 1, to)) + 1} of ${steps.length}`);
  };

  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(index, index - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(index, index + 1);
    }
  };

  const pickShared = (index: number, option: SharedOption) =>
    patch(index, { action: `Run flow ${option.name}`, sharedStepId: option.id, args: Object.fromEntries(option.params.map((p) => [p, ''])), inputs: [] });

  const addAssertion = (index: number, a: Assertion) => {
    const step = steps[index];
    if (step) patch(index, { assert: [...step.assert, a] });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[780px] border-collapse text-sm">
          <caption className="sr-only">Test steps</caption>
          <thead>
            <tr className="bg-surface-subtle text-left text-xs font-medium uppercase tracking-[0.05em] text-secondary">
              {HEADERS.map((h, i) => (
                <th key={h} scope="col" className={cn('px-2.5 py-2.5 font-medium', i === 0 && 'w-9 px-3.5', i === 3 && 'w-[220px]')}>
                  {h}
                </th>
              ))}
              <th scope="col" className="w-[140px] px-2.5 py-2.5">
                <span className="sr-only">Row actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => {
              const flow = step.sharedStepId !== undefined ? shared.find((s) => s.id === step.sharedStepId) : undefined;
              const isFlow = step.sharedStepId !== undefined;
              const tags = checkTags(step);
              const n = index + 1;
              return (
                <tr
                  key={step.uid}
                  data-testid={`step-row-${n}`}
                  onDragOver={(e) => {
                    if (dragFrom.current === null) return;
                    e.preventDefault();
                    setOverIndex(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current !== null) move(dragFrom.current, index);
                    dragFrom.current = null;
                    setOverIndex(null);
                  }}
                  className={cn('border-t border-divider-row align-top focus-within:bg-surface-subtle', overIndex === index && 'bg-primary-soft')}
                >
                  <td className="px-3.5 py-3.5 font-mono text-secondary">{n}</td>
                  <td className="px-2.5 py-3">
                    {isFlow ? (
                      <div className="flex flex-col gap-2">
                        <div className="min-h-[44px] rounded-tag border border-line-input bg-surface-subtle px-2.5 py-2 text-sm">
                          <Tag tone="primary" className="mr-2">
                            Shared step
                          </Tag>
                          {flow?.name ?? step.action}
                        </div>
                        {(flow?.params ?? Object.keys(step.args ?? {})).map((p) => (
                          <label key={p} className="flex items-center gap-2 text-xs text-secondary">
                            <span className="font-mono">{p}</span>
                            <Input
                              aria-label={`Argument ${p} of step ${n}`}
                              mono
                              className="h-[36px] flex-1 text-[13px]"
                              value={String(step.args?.[p] ?? '')}
                              onChange={(e) => patch(index, { args: { ...step.args, [p]: e.target.value } })}
                            />
                          </label>
                        ))}
                      </div>
                    ) : (
                      <>
                        <ActionField
                          label={`Action of step ${n}`}
                          value={step.action}
                          params={params}
                          shared={shared}
                          onPickShared={(opt) => pickShared(index, opt)}
                          placeholder="What should the tester do?"
                          onChange={(action) => patch(index, { action })}
                        />
                        <label className="mt-1.5 flex items-center gap-2 text-xs text-secondary">
                          Inputs:
                          <Input
                            aria-label={`Inputs of step ${n}`}
                            mono
                            placeholder="shipping_name, shipping_zip"
                            className="h-[36px] flex-1 text-[13px]"
                            value={step.inputs.join(', ')}
                            onChange={(e) =>
                              patch(index, {
                                inputs: e.target.value
                                  .split(',')
                                  .map((x) => x.trim())
                                  .filter((x) => x !== ''),
                              })
                            }
                          />
                        </label>
                      </>
                    )}
                  </td>
                  <td className="px-2.5 py-3">
                    <ActionField
                      label={`Expected result of step ${n}`}
                      value={step.expected ?? ''}
                      params={params}
                      placeholder="What should be true afterwards?"
                      onChange={(expected) => patch(index, { expected })}
                    />
                  </td>
                  <td className="px-3.5 py-3">
                    <div className="flex flex-col items-start gap-1.5 text-[13px]">
                      {tags.map((t) =>
                        t.kind === 'ai' ? (
                          <Tag key="ai" tone="ai">
                            AI check
                          </Tag>
                        ) : (
                          <span key={`${t.assertIndex}-${t.label}`} className="inline-flex items-center gap-1">
                            <Tag mono>{t.label}</Tag>
                            <button
                              type="button"
                              aria-label={`Remove check ${t.label}`}
                              onClick={() => patch(index, { assert: step.assert.filter((_, i) => i !== t.assertIndex) })}
                              className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-tag border-0 bg-transparent text-secondary"
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          </span>
                        ),
                      )}
                      <Button variant="dashed" className="text-xs" aria-label={`Add check to step ${n}`} onClick={() => setCheckFor(index)}>
                        + Add check
                      </Button>
                    </div>
                  </td>
                  <td className="px-2.5 py-2">
                    <div className="flex items-center">
                      <button
                        type="button"
                        draggable
                        ref={(el) => {
                          if (el) handles.current.set(step.uid, el);
                          else handles.current.delete(step.uid);
                        }}
                        aria-label={`Reorder step ${n}. Use arrow up and down to move.`}
                        onKeyDown={(e) => onHandleKey(e, index)}
                        onDragStart={(e) => {
                          dragFrom.current = index;
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', String(index));
                        }}
                        onDragEnd={() => {
                          dragFrom.current = null;
                          setOverIndex(null);
                        }}
                        className="inline-flex h-[44px] w-[44px] cursor-grab items-center justify-center rounded-control border-0 bg-transparent text-secondary"
                      >
                        <GripVertical size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate step ${n}`}
                        onClick={() => onChange(duplicateStep(steps, index))}
                        className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-control border-0 bg-transparent text-secondary"
                      >
                        <Copy size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete step ${n}`}
                        onClick={() => onChange(removeStep(steps, index))}
                        className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-control border-0 bg-transparent text-danger"
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {steps.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-secondary">
                  No steps yet. A test case needs at least one step.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="flex flex-wrap gap-2.5">
        <Button variant="dashed" className="min-h-[44px]" onClick={() => onChange([...steps, blankStep()])}>
          + Add step
        </Button>
        <Button variant="dashed" className="min-h-[44px]" onClick={onInsertShared}>
          + Insert shared step
        </Button>
        <Button variant="dashed" className="min-h-[44px]" disabled={onRecord === undefined} onClick={onRecord}>
          Record steps from here
        </Button>
      </div>
      <AssertionDialog
        open={checkFor !== null}
        onOpenChange={(o) => {
          if (!o) setCheckFor(null);
        }}
        onAdd={(a) => {
          if (checkFor !== null) addAssertion(checkFor, a);
        }}
      />
    </div>
  );
}
