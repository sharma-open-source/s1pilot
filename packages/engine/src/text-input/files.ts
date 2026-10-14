import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

/** Prefix of value refs naming a sample file to upload (`file:notes.txt`). */
export const FILE_REF_PREFIX = 'file:';

// Smallest valid files of common types, so upload widgets that sniff the content accept them.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

let dir: string | undefined;

/**
 * Path of a small generated sample file named `name` (directory parts are dropped), created on first
 * use in a per-process temp directory. Its content suits the extension (PNG, JPEG, PDF, JSON, CSV,
 * otherwise text), so a step such as `Upload "notes.txt"` needs no fixture file.
 */
export function sampleFile(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() || 'sample.txt';
  dir ??= mkdtempSync(join(tmpdir(), 's1pilot-upload-'));
  const path = join(dir, base);
  const ext = extname(base).toLowerCase();
  const body =
    ext === '.png'
      ? Buffer.from(PNG, 'base64')
      : ext === '.jpg' || ext === '.jpeg'
        ? Buffer.from(JPG, 'base64')
        : ext === '.pdf'
          ? PDF
          : ext === '.json'
            ? '{"sample": true}\n'
            : ext === '.csv'
              ? 'name,value\nsample,1\n'
              : 's1pilot sample upload file\n';
  writeFileSync(path, body);
  return path;
}
