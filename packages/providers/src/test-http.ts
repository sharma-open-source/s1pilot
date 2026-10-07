import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach } from 'vitest';

/** Local HTTP server helpers for adapter tests (never a real model endpoint). */

export interface Recorded {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** Local stand-in for a model server; `respond` receives the 1-based request number. */
export async function serve(respond: (n: number, res: ServerResponse) => void): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown> });
      respond(requests.length, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ close: () => { server.closeAllConnections(); server.close(); } });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

export const json = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

