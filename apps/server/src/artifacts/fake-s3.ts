import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** In-memory S3 endpoint (path-style) for tests: PutObject, GetObject with Range, DeleteObject, DeleteObjects. */
export interface FakeS3 {
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  /** Objects by `<bucket>/<key>`. */
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Requests seen as `METHOD /path`. */
  requests: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** Decodes an `aws-chunked` body (`<hex size>;chunk-signature=…\r\n<data>\r\n … 0\r\n<trailers>`). */
function decodeAwsChunked(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const eol = raw.indexOf('\r\n', pos);
    if (eol < 0) break;
    const size = parseInt(raw.subarray(pos, eol).toString('latin1').split(';')[0] ?? '0', 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(raw.subarray(eol + 2, eol + 2 + size));
    pos = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** Starts the fake on a free port. Authentication is not checked, but signed (presigned) URLs work like any other. */
export async function startFakeS3(): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map();
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push(`${req.method} ${url.pathname}`);
      const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
      if (req.method === 'PUT') {
        let body = await readBody(req);
        const enc = String(req.headers['content-encoding'] ?? '');
        if (enc.includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING')) body = decodeAwsChunked(body);
        objects.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') });
        res.writeHead(200, { etag: '"fake"' }).end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const obj = objects.get(key);
        if (!obj) {
          res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        const type = url.searchParams.get('response-content-type') ?? obj.contentType;
        const disposition = url.searchParams.get('response-content-disposition');
        const headers: Record<string, string | number> = { 'content-type': type, 'accept-ranges': 'bytes', ...(disposition ? { 'content-disposition': disposition } : {}) };
        const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (m) {
          const start = Number(m[1]);
          const end = Math.min(m[2] ? Number(m[2]) : obj.body.length - 1, obj.body.length - 1);
          const part = obj.body.subarray(start, end + 1);
          res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${obj.body.length}`, 'content-length': part.length }).end(req.method === 'HEAD' ? undefined : part);
        } else {
          res.writeHead(200, { ...headers, 'content-length': obj.body.length }).end(req.method === 'HEAD' ? undefined : obj.body);
        }
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else if (req.method === 'POST' && url.searchParams.has('delete')) {
        const xml = (await readBody(req)).toString('utf8');
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) objects.delete(`${key.replace(/\/$/, '')}/${m[1] ?? ''}`);
        res.writeHead(200, { 'content-type': 'application/xml' }).end('<DeleteResult></DeleteResult>');
      } else {
        res.writeHead(501).end();
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
