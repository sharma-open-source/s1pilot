import { useRef, useState } from 'react';

import { previewDataset, type DatasetPreview } from './model';

import { Button, Callout, Card, Dialog } from '@/components/ui';
import { errorMessage } from '@/lib/errors';

/** One data set as listed by `GET /api/projects/:key/datasets`. */
export interface DatasetInfo {
  name: string;
  rows: number;
  usedBy?: number | string[];
  note?: string;
}

function usage(d: DatasetInfo): string {
  if (d.note !== undefined) return d.note;
  const used = Array.isArray(d.usedBy) ? d.usedBy.join(', ') : d.usedBy;
  return `${d.rows} rows · ${used === undefined || used === 0 ? 'not used yet' : typeof used === 'number' ? `used by ${used} cases` : `used by ${used}`}`;
}

/** Test data sets grid with CSV / JSON upload and a first-20-rows preview. */
export function DatasetsCard({
  projectKey,
  datasets,
  loading,
  loadError,
  onUploaded,
}: {
  projectKey: string;
  datasets: DatasetInfo[];
  loading: boolean;
  loadError: string | null;
  onUploaded: () => void;
}) {
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
      const body = new FormData();
      body.append('file', file, file.name);
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/datasets`, { method: 'POST', body });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text !== '' && text.length < 200 ? text : `Upload failed (HTTP ${res.status})`);
      }
      close();
      onUploaded();
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
      {loading ? (
        <p className="text-sm text-secondary" role="status">
          Loading data sets…
        </p>
      ) : loadError !== null ? (
        <p className="text-sm text-secondary">Data sets are not available from the server yet ({loadError}).</p>
      ) : datasets.length === 0 ? (
        <p className="text-sm text-secondary">No data sets yet. Upload a CSV or JSON file to drive parameterised cases.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 p-0 text-sm">
          {datasets.map((d) => (
            <li key={d.name} className="rounded-control border border-divider p-3">
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
