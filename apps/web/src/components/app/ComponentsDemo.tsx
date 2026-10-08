import { useState, type ReactNode } from 'react';

import { PageHeader } from './PageHeader';

import {
  Breadcrumb,
  Button,
  Callout,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  InsetBox,
  LinkButton,
  Pill,
  Range,
  Segmented,
  Select,
  Skeleton,
  STATUS_PILLS,
  StatusPill,
  Tabs,
  Tag,
  Textarea,
  type ButtonVariant,
  type PillTone,
} from '@/components/ui';


const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ink', 'danger-outline', 'dashed'];
const PILL_TONES: PillTone[] = ['running', 'success', 'danger', 'warning', 'flaky', 'neutral', 'draft', 'queued'];

function Demo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card aria-label={title}>
      <CardHeader title={title} />
      <div className="flex flex-wrap items-start gap-3 p-[18px]">{children}</div>
    </Card>
  );
}

/** Dev-only gallery of every shared primitive (`/_dev/components`). Add new shared components here. */
export function ComponentsDemo() {
  const [seg, setSeg] = useState('failed');
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Dev" title="Components" />

      <Demo title="Button">
        {VARIANTS.map((v) => (
          <Button key={v} variant={v}>
            {v === 'dashed' ? '+ Add step' : v}
          </Button>
        ))}
        <Button variant="secondary" size="sm">
          Small
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Demo>

      <Demo title="LinkButton">
        <LinkButton to="/" variant="secondary">
          Back to dashboard
        </LinkButton>
        <LinkButton href="https://example.com" variant="primary">
          External link
        </LinkButton>
      </Demo>

      <Demo title="Input, Select, Textarea, Field">
        <Field label="Base URL" className="w-full max-w-[320px]">
          {(id) => <Input id={id} mono defaultValue="http://127.0.0.1:4400/shop" />}
        </Field>
        <Field label="Browser" className="w-full max-w-[200px]">
          {(id) => (
            <Select id={id} defaultValue="chromium">
              <option value="chromium">Chromium</option>
              <option value="firefox">Firefox</option>
            </Select>
          )}
        </Field>
        <Field label="Note" className="w-full max-w-[320px]" hint="Plain sentence-case hint.">
          {(id) => <Textarea id={id} defaultValue="Checkout badge looks wrong." />}
        </Field>
      </Demo>

      <Demo title="Checkbox, Range">
        <Checkbox label="Run dual-order check" defaultChecked />
        <Field label="Pass threshold" className="w-full max-w-[320px]">
          {(id) => <Range id={id} min={0} max={1} step={0.05} defaultValue={0.8} />}
        </Field>
      </Demo>

      <Demo title="Card, CardHeader, InsetBox">
        <Card className="w-full max-w-[360px]">
          <CardHeader title="Recent runs" action={<a href="#runs">View all</a>} />
          <div className="p-[18px]">
            <InsetBox>Inset content</InsetBox>
          </div>
        </Card>
      </Demo>

      <Demo title="Tabs">
        <Tabs
          aria-label="Demo tabs"
          className="w-full"
          items={[
            { label: 'Components', to: '/_dev/components' },
            { label: 'Dashboard', to: '/' },
          ]}
        />
      </Demo>

      <Demo title="Segmented">
        <Segmented
          aria-label="Result filter"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'failed', label: 'Failed' },
            { value: 'review', label: 'Review' },
            { value: 'all', label: 'All' },
          ]}
        />
      </Demo>

      <Demo title="StatusPill (all statuses)">
        {(Object.keys(STATUS_PILLS) as (keyof typeof STATUS_PILLS)[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-2">
            <StatusPill status={s} />
            <code className="font-mono text-xs text-muted">{s}</code>
          </span>
        ))}
      </Demo>

      <Demo title="Pill tones">
        {PILL_TONES.map((t) => (
          <Pill key={t} tone={t}>
            {t}
          </Pill>
        ))}
      </Demo>

      <Demo title="Tag">
        <Tag>Neutral</Tag>
        <Tag mono>flow: clear-cart</Tag>
        <Tag tone="ai">AI check</Tag>
        <Tag tone="danger">S1 · Critical</Tag>
        <Tag tone="warning">S2 · Major</Tag>
        <Tag tone="primary">{'{param}'}</Tag>
      </Demo>

      <Demo title="Callout">
        <Callout tone="warning" className="w-full">
          Threshold callout.
        </Callout>
        <Callout tone="info-ai" className="w-full">
          Hybrid mode: AI pre-runs the steps.
        </Callout>
        <Callout tone="danger" className="w-full">
          Something failed. Retry.
        </Callout>
        <Callout tone="success" className="w-full">
          Connected · decision returned in 142 ms
        </Callout>
      </Demo>

      <Demo title="Breadcrumb">
        <Breadcrumb items={[{ label: 'SHOP', to: '/' }, { label: 'Test cases', to: '/' }, { label: 'SHOP-TC-42' }]} />
      </Demo>

      <Demo title="EmptyState">
        <EmptyState className="w-full" action={<Button variant="secondary">New test case</Button>}>
          No test cases yet.
        </EmptyState>
      </Demo>

      <Demo title="Skeleton">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </Demo>

      <Demo title="Dialog, ConfirmDialog">
        <Button variant="secondary" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <Button variant="danger-outline" onClick={() => setConfirm(true)}>
          Abort run
        </Button>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Run launcher"
          description="Pick where to run."
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Run now
              </Button>
            </>
          }
        />
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          tone="danger"
          title="Abort this run?"
          description="The browser closes and unfinished steps are marked blocked."
          confirmLabel="Abort run"
          onConfirm={() => undefined}
        />
      </Demo>
    </>
  );
}
