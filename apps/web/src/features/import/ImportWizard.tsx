import { useRef, useState } from 'react';

import { Button, Callout, Dialog, Field, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useProjects } from '@/lib/nav-data';
import { trpc } from '@/lib/trpc';

const FORMATS = [
  { value: 'csv', label: 'CSV' },
  { value: 'gherkin', label: 'Gherkin (.feature)' },
  { value: 'testrail', label: 'TestRail (XML / CSV)' },
  { value: 'xray', label: 'Xray (JSON)' },
  { value: 'zephyr', label: 'Zephyr (CSV)' },
  { value: 'playwright', label: 'Playwright spec' },
] as const;
type Format = (typeof FORMATS)[number]['value'];

const MAPPING_FIELDS = [
  { key: 'title', label: 'Title', required: true },
  { key: 'id', label: 'External id' },
  { key: 'suite', label: 'Suite' },
  { key: 'priority', label: 'Priority' },
  { key: 'tags', label: 'Tags' },
  { key: 'steps', label: 'Steps' },
  { key: 'expected', label: 'Expected result' },
  { key: 'data', label: 'Test data' },
] as const;
type MappingKey = (typeof MAPPING_FIELDS)[number]['key'];
type Mapping = Partial<Record<MappingKey, string>>;

type StepName = 'upload' | 'preview' | 'target' | 'report';
const STEPS: Array<{ id: StepName; label: string }> = [
  { id: 'upload', label: '1. Upload' },
  { id: 'preview', label: '2. Mapping preview' },
  { id: 'target', label: '3. Target suite' },
  { id: 'report', label: '4. Report' },
];

export interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project to import into; when absent the wizard asks for one. */
  projectKey?: string;
  /** Suite pre-selected as the target. */
  suiteId?: string;
  /** Called after an import finished, so lists can refresh. */
  onImported?: () => void;
}

/** Import wizard (S-062): upload, detect the format, preview the mapping (first 10), choose the target suite, read the report. */
export function ImportWizard({ open, onOpenChange, projectKey: fixedKey, suiteId: initialSuite, onImported }: ImportWizardProps) {
  const projects = useProjects();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<StepName>('upload');
  const [pickedKey, setPickedKey] = useState('');
  const projectKey = fixedKey ?? (pickedKey || projects.data[0]?.key || '');
  const [file, setFile] = useState<{ filename: string; content: string } | undefined>();
  const [format, setFormat] = useState<Format | ''>('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [suiteId, setSuiteId] = useState(initialSuite ?? '');
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);

  const tree = trpc.suites.tree.useQuery({ projectKey }, { enabled: open && step === 'target' && projectKey !== '' });
  const preview = trpc.imports.preview.useMutation({
    onSuccess: (res) => {
      setError(undefined);
      setFormat(res.format);
      if (res.mapping) setMapping((m) => ({ ...(res.mapping as Mapping), ...m }));
      setStep('preview');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const run = trpc.imports.run.useMutation({
    onSuccess: () => {
      setError(undefined);
      setStep('report');
      onImported?.();
      void utils.cases.list.invalidate();
      void utils.suites.tree.invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const reset = (): void => {
    setStep('upload');
    setFile(undefined);
    setFormat('');
    setMapping({});
    setError(undefined);
    preview.reset();
    run.reset();
  };
  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) reset();
  };

  const source = (): { projectKey: string; filename: string; content: string; format?: Format; mapping?: Mapping } | undefined =>
    file === undefined
      ? undefined
      : {
          projectKey,
          ...file,
          ...(format !== '' ? { format } : {}),
          ...(format === 'csv' || (format === '' && Object.keys(mapping).length > 0) ? { mapping: cleanMapping(mapping) } : {}),
        };

  const pick = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    setError(undefined);
    if (f.size > 5_000_000) {
      setError('The file is too large (5 MB max).');
      return;
    }
    setFile({ filename: f.name, content: await f.text() });
    setFormat('');
    setMapping({});
  };

  const data = preview.data;
  const report = run.data;
  const flat = flatten(tree.data?.tree ?? []);

  let footer;
  if (step === 'upload') {
    footer = (
      <>
        <Button onClick={() => close(false)}>Cancel</Button>
        <Button
          variant="primary"
          disabled={file === undefined || projectKey === '' || preview.isPending}
          onClick={() => {
            const s = source();
            if (s) preview.mutate(s);
          }}
        >
          {preview.isPending ? 'Reading…' : 'Preview'}
        </Button>
      </>
    );
  } else if (step === 'preview') {
    footer = (
      <>
        <Button onClick={() => setStep('upload')}>Back</Button>
        <Button
          variant="primary"
          disabled={data === undefined || data.total === 0 || (format === 'csv' && !mapping.title)}
          onClick={() => setStep('target')}
        >
          Choose target suite
        </Button>
      </>
    );
  } else if (step === 'target') {
    footer = (
      <>
        <Button onClick={() => setStep('preview')}>Back</Button>
        <Button
          variant="primary"
          disabled={run.isPending}
          onClick={() => {
            const s = source();
            if (s) run.mutate({ ...s, ...(suiteId !== '' ? { suiteId } : {}) });
          }}
        >
          {run.isPending ? 'Importing…' : `Import ${data?.total ?? 0} cases`}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button onClick={reset}>Import another file</Button>
        <Button variant="primary" onClick={() => close(false)}>
          Done
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Import test cases"
      description="Bring in cases from CSV, Gherkin, TestRail, Xray, Zephyr or Playwright specs. Imported cases arrive as drafts; importing the same file again updates them."
      wide
      footer={footer}
    >
      <ol aria-label="Import steps" className="m-0 flex list-none flex-wrap gap-2 p-0 text-[13px]">
        {STEPS.map((s) => (
          <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className={s.id === step ? 'font-semibold text-fg' : 'text-secondary'}>
            {s.label}
          </li>
        ))}
      </ol>
      {error !== undefined && <Callout tone="danger">{error}</Callout>}

      {step === 'upload' && (
        <div className="flex flex-col gap-3.5">
          {fixedKey === undefined && (
            <Field label="Project">
              {(id) => (
                <Select id={id} value={projectKey} onChange={(e) => setPickedKey(e.target.value)}>
                  {projects.data.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} · {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="File" hint="CSV, .feature, TestRail .xml/.csv, Xray .json, Zephyr .csv or a .spec.ts file (5 MB max).">
            {(id) => (
              <input
                id={id}
                ref={input}
                type="file"
                accept=".csv,.feature,.xml,.json,.ts,.js,.txt"
                className="min-h-[44px] rounded-control border border-dashed border-line-dashed-strong p-2.5 text-sm"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            )}
          </Field>
          {file !== undefined && <span className="font-mono text-[13px] text-secondary">{file.filename}</span>}
        </div>
      )}

      {step === 'preview' && data !== undefined && (
        <div className="flex flex-col gap-3.5">
          <Field label="Format" hint="Detected from the file; change it if the guess is wrong.">
            {(id) => (
              <Select
                id={id}
                value={format}
                onChange={(e) => {
                  const f = e.target.value as Format;
                  setFormat(f);
                  const s = file && { projectKey, ...file, format: f };
                  if (s) preview.mutate(s);
                }}
              >
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {format === 'csv' && (
            <fieldset className="m-0 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 border-0 p-0">
              <legend className="mb-2 text-[13px] font-medium text-fg">Column mapping</legend>
              {MAPPING_FIELDS.map((f) => (
                <Field key={f.key} label={f.label + ('required' in f ? ' *' : '')}>
                  {(id) => (
                    <Select
                      id={id}
                      value={mapping[f.key] ?? ''}
                      onChange={(e) => {
                        const next = { ...mapping, [f.key]: e.target.value };
                        setMapping(next);
                        if (file) preview.mutate({ projectKey, ...file, format: 'csv', mapping: cleanMapping(next) });
                      }}
                    >
                      <option value="">(none)</option>
                      {data.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </fieldset>
          )}
          <p className="m-0 text-sm text-secondary" aria-live="polite">
            {data.total} cases found: {data.willCreate} new, {data.willUpdate} will be updated
            {data.errors.length > 0 ? `, ${data.errors.length} cannot be imported` : ''}. Showing the first {Math.min(10, data.sample.length)}.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="text-[13px] text-secondary">
                  <th className="p-2">External id</th>
                  <th className="p-2">Title</th>
                  <th className="p-2">Suite</th>
                  <th className="p-2">Priority</th>
                  <th className="p-2">Steps</th>
                </tr>
              </thead>
              <tbody>
                {data.sample.map((c) => (
                  <tr key={c.externalRef} className="border-t border-line">
                    <td className="p-2 font-mono text-[13px]">{c.externalRef}</td>
                    <td className="p-2">
                      {c.title}
                      {c.parameterRows > 0 && <span className="ml-2 text-[13px] text-secondary">{c.parameterRows} parameter rows</span>}
                    </td>
                    <td className="p-2">{c.suitePath.join(' / ') || '–'}</td>
                    <td className="p-2 font-mono">{c.priority}</td>
                    <td className="p-2 font-mono">{c.stepCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.errors.length > 0 && <ErrorList items={data.errors} />}
        </div>
      )}

      {step === 'target' && (
        <Field label="Target suite" hint="Folders and sections from the file are created inside this suite.">
          {(id) => (
            <Select id={id} value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
              <option value="">Top level (no suite)</option>
              {flat.map((s) => (
                <option key={s.id} value={s.id}>
                  {'– '.repeat(s.depth)}
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {step === 'report' && report !== undefined && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <Callout tone={report.errors.length > 0 ? 'warning' : 'success'}>
            Import finished: {report.created} created, {report.updated} updated, {report.skipped} skipped (unchanged), {report.errors.length} errors.
          </Callout>
          {report.errors.length > 0 && <ErrorList items={report.errors} />}
        </div>
      )}
    </Dialog>
  );
}

function ErrorList({ items }: { items: Array<{ index: number; title?: string | undefined; message: string }> }) {
  return (
    <ul aria-label="Import errors" className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-danger-strong">
      {items.map((e, i) => (
        <li key={i}>
          <span className="font-mono">#{e.index}</span> {e.title !== undefined ? `${e.title}: ` : ''}
          {e.message}
        </li>
      ))}
    </ul>
  );
}

function cleanMapping(m: Mapping): Mapping {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as Mapping;
}

function flatten(nodes: Array<{ id: string; name: string; children: unknown[] }>, depth = 0): Array<{ id: string; name: string; depth: number }> {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flatten(n.children as Array<{ id: string; name: string; children: unknown[] }>, depth + 1)]);
}
