import type { MatrixEntry } from '@s1pilot/domain';
import { useState, type ReactNode } from 'react';

import { CapabilityGrid } from './CapabilityGrid';
import { CodeBlock } from './CodeBlock';
import { BrowserTile, DecisionPanel, EventLog, ProbabilityBar, RunProgressBar, StepStatusList } from './live';
import { MatrixTable } from './MatrixTable';
import { ModeMixBar } from './ModeMixBar';
import { PageHeader } from './PageHeader';
import { ExpectedActual, ResultListItem, ScreenshotTimeline } from './report';
import { DiffLine, ReviewListItem } from './review';
import { Sparkline, StatTile } from './StatTile';
import { WizardStepper } from './WizardStepper';

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
import { changeDevice, toggleCell } from '@/features/plans/model';


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
  const [matrix, setMatrix] = useState<MatrixEntry[]>([{ environmentId: 'stg', browser: 'chromium' }]);
  const [device, setDevice] = useState('Pixel 7');
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

      <Demo title="MatrixTable">
        <MatrixTable
          envs={[
            { id: 'stg', name: 'staging', readOnly: false, browsers: [] },
            { id: 'prod', name: 'prod', readOnly: true, browsers: [{ browser: 'chromium' }] },
          ]}
          matrix={matrix}
          device={device}
          onToggle={(envId, col) => setMatrix((m) => toggleCell(m, envId, col, device))}
          onDevice={(d) => {
            setDevice(d);
            setMatrix((m) => changeDevice(m, d));
          }}
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

      <Demo title="WizardStepper">
        <WizardStepper
          current="models"
          steps={[
            { id: 'basics', label: 'Basics' },
            { id: 'environments', label: 'Environments' },
            { id: 'models', label: 'Models' },
            { id: 'login', label: 'Login setup' },
            { id: 'first-tests', label: 'First tests' },
          ]}
        />
      </Demo>

      <Demo title="CapabilityGrid">
        <CapabilityGrid
          adapter="systemone"
          capabilities={{ maxOptions: 8, multiQuestionPerCall: true, supportsImages: true, maxContextTokens: 32768 }}
          className="w-full"
        />
        <CapabilityGrid className="w-full" />
      </Demo>

      <Demo title="StatTile, Sparkline">
        <StatTile label="Pass rate · last 7 days" value="92%" className="w-56">
          <Sparkline values={[80, 85, null, 90, 88, 95, 92]} label="Daily pass rate" />
        </StatTile>
        <StatTile label="Needs review" value={4} tone="warning" className="w-56">
          <div className="text-[13px] text-strong-2">AI verdicts + heal proposals</div>
        </StatTile>
      </Demo>

      <Demo title="ModeMixBar">
        <ModeMixBar mix={{ replay: 60, heal: 15, explore: 25 }} className="w-full" />
      </Demo>

      <Demo title="Skeleton">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full" />
      </Demo>

      <Demo title="Live run: BrowserTile (parallel browsers grid)">
        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          <BrowserTile title="SHOP-TC-42" status="running" detail="Step 3 · Checkout as guest" frame={null} onOpen={() => undefined} />
          <BrowserTile title="SHOP-TC-43" status="running" detail="Step 2 · Pick colour & size" frame={null} waiting onOpen={() => undefined} />
        </div>
      </Demo>

      <Demo title="Live run: ProbabilityBar, RunProgressBar, StepStatusList, DecisionPanel, EventLog">
        <div className="flex w-full flex-wrap gap-4">
          <div className="flex w-64 flex-col gap-3">
            <ProbabilityBar label="e3 · Checkout as guest" value={0.62} top />
            <ProbabilityBar label="e7 · Sign in" value={0.21} />
            <RunProgressBar counts={{ passed: 5, failed: 1, review: 1, queued: 3 }} />
            <StepStatusList
              steps={[
                { index: 0, title: 'Open Classic Tee', status: 'passed', suffix: 'replay' },
                { index: 1, title: 'Checkout as guest', status: 'running', suffix: 'heal · locator changed' },
                { index: 2, title: 'Stop before payment', status: 'pending' },
              ]}
            />
          </div>
          <div className="w-80">
            <DecisionPanel
              step={2}
              model="clef-flash"
              latencyMs={84}
              question="which element performs the step?"
              rows={[{ id: 'e3', label: 'e3 · Checkout as guest', p: 0.62 }]}
              allOptions={[{ id: 'e3', label: 'e3 · Checkout as guest', p: 0.62 }]}
              callout={{ title: 'Below act threshold (0.80)', body: 'Waiting for your approval.' }}
              actions={{ approveId: 'e3', onApprove: () => undefined, onPick: () => undefined, onSkip: () => undefined }}
            />
          </div>
          <EventLog className="w-full" lines={[{ id: 1, time: '10:00:01', text: 'step 3 replay failed → heal', warn: false }, { id: 2, time: '10:00:02', text: 'S1 conf=0.62 awaiting approval', warn: true }]} />
        </div>
      </Demo>

      <Demo title="Run report: ResultListItem, ExpectedActual, ScreenshotTimeline">
        <div className="flex w-full flex-col gap-3">
          <div className="w-full max-w-[440px] rounded-card border border-line bg-surface">
            <ResultListItem resultKey="SHOP-TC-44" title="Invalid ZIP shows a field error" meta="staging · WebKit · step 3" status="failed" selected to="/_dev/components" search={{}} />
            <ResultListItem resultKey="SHOP-TC-51" title="Order confirmation email arrives" meta="staging · Chromium · step 5" status="blocked" to="/_dev/components" search={{}} />
          </div>
          <ExpectedActual expected="An error appears next to the ZIP field" actual={'Form submitted; payment step shown with ZIP "ABCDE"'} />
          <ScreenshotTimeline
            steps={[
              { index: 0, title: 'Add item', suffix: '✓ replay', state: 'passed' },
              { index: 1, title: 'Enter ZIP', suffix: '✗', state: 'failed' },
              { index: 2, title: 'Pay', suffix: 'not run', state: 'not-run' },
            ]}
          />
        </div>
      </Demo>

      <Demo title="Review queue: ReviewListItem, DiffLine">
        <div className="flex w-full flex-wrap gap-4">
          <div className="w-full max-w-[380px] rounded-card border border-line bg-surface">
            <ReviewListItem title="“Guest checkout” → “Checkout as guest”" meta="Shared step “guest-checkout” · used by 6 cases · conf 0.62" selected to="/_dev/components" search={{}} />
            <ReviewListItem title="Promo field moved into accordion" meta="SHOP-TC-43 step 2 · conf 0.88" resolved="approved" to="/_dev/components" search={{}} />
          </div>
          <div className="flex w-full max-w-[420px] flex-col gap-2">
            <DiffLine kind="removed">{"getByRole('button', {name: 'Guest checkout'})"}</DiffLine>
            <DiffLine kind="added">{"getByRole('button', {name: 'Checkout as guest'})"}</DiffLine>
          </div>
        </div>
      </Demo>

      <Demo title="CodeBlock">
        <div className="w-full">
          <CodeBlock code={'npx s1pilot run --plan "Checkout regression" --env staging \\\n  --server https://s1pilot.local --token $S1P_TOKEN'} label="CLI command" />
        </div>
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
