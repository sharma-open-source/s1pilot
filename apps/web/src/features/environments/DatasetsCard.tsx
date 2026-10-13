import { useRef, useState } from 'react';

import { previewDataset, type DatasetPreview } from './model';

import { Button, Callout, Card, Dialog } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

/** One data set as listed by `datasets.list`. */
export type DatasetInfo = RouterOutputs['datasets']['list'][number];

function usage(d: DatasetInfo): string {
  const scope = d.environment !== null ? ` · ${d.environment} only` : '';
  return `${d.rows} rows · ${d.usedBy === 0 ? 'not used yet' : `used by ${d.usedBy} ${d.usedBy === 1 ? 'case' : 'cases'}`}${scope}`;
}

/** Test data sets grid with CSV / JSON upload and a first-20-rows preview. */
export function DatasetsCard({ projectKey }: { projectKey: string }) {
  const utils = trpc.useUtils();
  const list = trpc.datasets.list.useQuery({ projectKey });
  const uploadMutation = trpc.datasets.upload.useMutation({ onSuccess: () => utils.datasets.list.invalidate({ projectKey }) });
  const datasets = list.data ?? [];
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const choose = async (f: File | undefined) => {
    if (f === undefined) return;
    setError(null);
    try {
      setPreview(previewDataset(f.name, await f.text()));
      setFile(f);
    } catch (err) {
      setFile(null);
      setPreview(null);
      setError(errorMessage(err));
    }
  };

  const close = () => {
    setPreview(null);
    setFile(null);
    setUploading(false);
  };

  const upload = async () => {
    if (file === null) return;
    setUploading(true);
    setError(null);
    try {
      await uploadMutation.mutateAsync({ projectKey, fileName: file.name, content: await file.text() });
      close();
    } catch (err) {
      setUploading(false);
      setError(errorMessage(err));
    }
  };

  return (
    <Card aria-label="Test data" className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold text-fg">Test data sets</h2>
        <Button size="sm" onClick={() => picker.current?.click()}>
          Upload CSV / JSON
        </Button>
        <input
          ref={picker}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          aria-label="Choose a CSV or JSON file"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            void choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error !== null && preview === null && <Callout tone="danger">{error}</Callout>}
      {list.isLoading ? (
        <p className="text-sm text-secondary" role="status">
          Loading data sets…
        </p>
      ) : list.isError ? (
        <Callout tone="danger">
          Could not load data sets: {errorMessage(list.error)}{' '}
          <Button size="sm" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </Callout>
      ) : datasets.length === 0 ? (
        <p className="text-sm text-secondary">No data sets yet. Upload a CSV or JSON file to drive parameterised cases.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 p-0 text-sm">
          {datasets.map((d) => (
            <li key={d.id} className="rounded-control border border-divider p-3">
              <strong className="font-mono text-[13px]">{d.name}</strong>
              <div className="text-xs text-strong-2">{usage(d)}</div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={preview !== null}
        onOpenChange={(o) => {
          if (!o) close();
        }}
        title={`Preview ${preview?.name ?? ''}`}
        description={preview !== null ? `${preview.totalRows} rows, ${preview.columns.length} columns. Showing the first ${preview.rows.length}.` : undefined}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={uploading} onClick={() => void upload()}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        }
      >
        {error !== null && <Callout tone="danger">{error}</Callout>}
        {preview !== null && (
          <div className="overflow-auto">
            <table className="w-full border-collapse font-mono text-xs">
              <thead>
                <tr className="text-left text-secondary">
                  {preview.columns.map((c, i) => (
                    <th key={`${c}-${i}`} scope="col" className="border-b border-divider px-2 py-1.5 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} className="border-t border-divider">
                    {preview.columns.map((c, j) => (
                      <td key={`${c}-${j}`} className="px-2 py-1.5">
                        {r[j] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
