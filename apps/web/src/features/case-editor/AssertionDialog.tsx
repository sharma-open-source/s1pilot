import type { Assertion } from '@s1pilot/domain';
import { useState } from 'react';

import { ASSERTION_TYPES, buildAssertion, summarizeAssertion, type AssertionValues } from './model';

import { Button, Callout, Checkbox, Dialog, Field, Input, Select, Tag } from '@/components/ui';

interface AssertionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (assertion: Assertion) => void;
}

/** Assertion builder: pick an assertion type, fill its fields, preview the summary tag, add it to the step. */
export function AssertionDialog({ open, onOpenChange, onAdd }: AssertionDialogProps) {
  const [type, setType] = useState<Assertion['type']>('urlMatches');
  const [values, setValues] = useState<AssertionValues>({});
  const [showError, setShowError] = useState(false);

  const def = ASSERTION_TYPES.find((t) => t.type === type);
  const built = buildAssertion(type, values);

  const close = (next: boolean) => {
    if (!next) {
      setValues({});
      setShowError(false);
    }
    onOpenChange(next);
  };

  const submit = () => {
    if (!built.ok) {
      setShowError(true);
      return;
    }
    onAdd(built.assertion);
    close(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add check"
      description="A deterministic assertion evaluated after the step. Without one, the expected result is judged by AI."
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Add check
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Check type">
          {(id) => (
            <Select
              id={id}
              value={type}
              onChange={(e) => {
                setType(e.target.value as Assertion['type']);
                setValues({});
                setShowError(false);
              }}
            >
              {ASSERTION_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {def?.fields.map((f) =>
          f.kind === 'checkbox' ? (
            <Checkbox
              key={`${type}-${f.name}`}
              label={f.label}
              checked={values[f.name] === true}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })}
            />
          ) : f.kind === 'select' ? (
            <Field key={`${type}-${f.name}`} label={f.label}>
              {(id) => (
                <Select id={id} value={String(values[f.name] ?? f.options?.[0] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field key={`${type}-${f.name}`} label={f.required === true ? `${f.label} (required)` : f.label} hint={f.hint}>
              {(id) => (
                <Input
                  id={id}
                  mono
                  inputMode={f.kind === 'number' ? 'numeric' : undefined}
                  value={typeof values[f.name] === 'string' ? (values[f.name] as string) : ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </Field>
          ),
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-secondary">
          Preview
          {built.ok ? (
            <Tag mono data-testid="assertion-preview">
              {summarizeAssertion(built.assertion)}
            </Tag>
          ) : (
            <span className="text-muted">Fill the required fields</span>
          )}
        </div>
        {showError && !built.ok && <Callout tone="danger">{built.error}</Callout>}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Add
        </button>
      </form>
    </Dialog>
  );
}
