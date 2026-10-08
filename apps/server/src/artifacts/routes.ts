import type { FastifyInstance } from 'fastify';

import type { ArtifactStore, ByteRange } from './store.js';

/** Parses a single `Range: bytes=…` header. Returns undefined when absent/unsupported, `'invalid'` when unsatisfiable. */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'invalid' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/**
 * Registers `GET /api/artifacts/:id` (content with content-type and byte-range support) and
 * `GET /api/artifacts/:id/trace-viewer` (how to open a Playwright trace).
 */
export function registerArtifactRoutes(app: FastifyInstance, store: ArtifactStore): void {
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const record = await store.stat(req.params.id);
    if (!record) return reply.code(404).send({ error: 'Artifact not found' });
    const range = parseRange(req.headers.range, record.size);
    reply
      .header('content-type', record.contentType)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${record.contentType.startsWith('image/') || record.contentType.startsWith('video/') ? 'inline' : 'attachment'}; filename="${record.name.replace(/"/g, '')}"`,
      );
    if (range === 'invalid') {
      return reply.code(416).header('content-range', `bytes */${record.size}`).send();
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${record.size}`)
        .header('content-length', range.end - range.start + 1)
        .send(await store.get(record.id, range));
    }
    return reply.header('content-length', record.size).send(await store.get(record.id));
  });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id/trace-viewer', async (req, reply) => {
    const record = await store.stat(req.params.id);
    if (!record) return reply.code(404).send({ error: 'Artifact not found' });
    if (record.kind !== 'trace')
      return reply.code(400).send({ error: 'Artifact is not a Playwright trace' });
    const url = `${req.protocol}://${req.headers.host ?? 'localhost'}/api/artifacts/${record.id}`;
    return {
      artifactId: record.id,
      downloadUrl: url,
      command: `npx playwright show-trace ${url}`,
      instructions:
        'Download the trace zip and open it with `npx playwright show-trace <file>`, or run the command above (it fetches the trace from this server).',
    };
  });
}
