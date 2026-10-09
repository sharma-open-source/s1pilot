import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Ctx, ServerState, SiteHandler } from './context.js';
import { BUG_IDS, VARIANT_IDS, parseList, readCookie, type Flags } from './flags.js';
import { esc } from './html.js';
import { forms } from './sites/forms.js';
import { mail } from './sites/mail.js';
import { quality } from './sites/quality.js';
import { settings } from './sites/settings.js';
import { shop } from './sites/shop.js';

export interface FixtureOptions {
  /** Port to listen on; default 0 (random free port). */
  port?: number;
  /** Seeded bugs to enable for every request, e.g. `['shop.badge-wrong-count']`. */
  bugs?: string[];
  /** UI variants, as one id or a comma-separated list. */
  variant?: string;
}

export interface FixtureServer {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:41233`. */
  url: string;
  close(): Promise<void>;
}

const SITES: Record<string, SiteHandler> = { shop, settings, forms, mail, quality };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function index(): string {
  const links = Object.keys(SITES)
    .map((name) => `<li><a href="/${name}">/${name}</a></li>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture sites</title></head>
<body><main><h1>s1-pilot fixture sites</h1><ul>${links}</ul>
<p>Enable bugs with <code>?bugs=${esc(BUG_IDS[0])}</code> and variants with <code>?variant=${esc(VARIANT_IDS[0])}</code>.</p>
</main></body></html>`;
}

/**
 * Starts the demo sites (`/shop`, `/settings`, `/forms`, `/mail`) on a local port.
 * Bugs and variants can be fixed by options, or switched per browser with `?bugs=` / `?variant=`
 * (remembered in a cookie) or the `x-fixture-bugs` / `x-fixture-variant` headers.
 * Throws on unknown ids in `options`.
 */
export async function startFixtureServer(options: FixtureOptions = {}): Promise<FixtureServer> {
  const baseBugs = parseList((options.bugs ?? []).join(','), BUG_IDS, true);
  const baseVariants = parseList(options.variant, VARIANT_IDS, true);
  const state: ServerState = {
    settings: { name: 'Alex Doe', email: 'alex@example.com', notifications: true, darkMode: false, deleted: false },
    flakySessions: 0,
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fixture.local');
      const queryBugs = url.searchParams.get('bugs');
      const queryVariant = url.searchParams.get('variant');
      const bugsRaw = queryBugs ?? (req.headers['x-fixture-bugs'] as string | undefined) ?? readCookie(req.headers.cookie, 'fx_bugs');
      const variantRaw =
        queryVariant ?? (req.headers['x-fixture-variant'] as string | undefined) ?? readCookie(req.headers.cookie, 'fx_variant');
      const bugs = new Set([...baseBugs, ...parseList(bugsRaw, BUG_IDS, false)]);
      const flags: Flags = {
        bugs,
        variants: new Set([...baseVariants, ...parseList(variantRaw, VARIANT_IDS, false)]),
      };

      const cookies: string[] = [];
      if (bugs.has('shop.flaky-badge') && url.pathname.startsWith('/shop')) {
        // 50% flaky: every second browser session (cookie jar) gets the wrong badge count.
        let phase = readCookie(req.headers.cookie, 'fx_flaky');
        if (phase !== 'bad' && phase !== 'ok') {
          phase = state.flakySessions++ % 2 === 0 ? 'bad' : 'ok';
          cookies.push(`fx_flaky=${phase}; Path=/`);
        }
        if (phase === 'bad') bugs.add('shop.badge-wrong-count');
      }
      if (queryBugs !== null) cookies.push(`fx_bugs=${encodeURIComponent(queryBugs)}; Path=/`);
      if (queryVariant !== null) cookies.push(`fx_variant=${encodeURIComponent(queryVariant)}; Path=/`);

      const send = (status: number, type: string, body: string, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
        res.end(body);
      };
      const extraCookies = (headers?: Record<string, string>): Record<string, string[]> => {
        const set = [...cookies, ...(headers?.['set-cookie'] ? [headers['set-cookie']] : [])];
        return set.length > 0 ? { 'set-cookie': set } : {};
      };

      const [, site = '', ...rest] = url.pathname.split('/');
      const ctx: Ctx = {
        req,
        res,
        url,
        path: `/${rest.join('/')}`,
        flags,
        state,
        form: async () => new URLSearchParams(await readBody(req)),
        json: async () => JSON.parse((await readBody(req)) || 'null') as unknown,
        html: (body, status = 200) => send(status, 'text/html; charset=utf-8', body, extraCookies()),
        redirect: (location, headers) => send(303, 'text/plain', '', { location, ...extraCookies(headers) }),
        sendJson: (body, status = 200) => send(status, 'application/json', JSON.stringify(body), extraCookies()),
        notFound: () => send(404, 'text/html; charset=utf-8', '<!doctype html><title>Not found</title><h1>Not found</h1>'),
      };

      try {
        const handler = SITES[site];
        if (site === '' && url.pathname === '/') ctx.html(index());
        else if (handler) await handler(ctx);
        else ctx.notFound();
      } catch (error) {
        send(500, 'text/plain', error instanceof Error ? error.message : 'error');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
