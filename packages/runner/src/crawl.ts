import type { Browser } from 'playwright';

/** A form found on a crawled page. Field values are never read. */
export interface CrawledForm {
  /** Visible labels (or names/placeholders) of the inputs. */
  fields: string[];
  /** Text of the submit control, when there is one. */
  submit?: string;
}

/** Summary of one crawled page: what a tester could do there. */
export interface CrawledPage {
  url: string;
  title: string;
  headings: string[];
  forms: CrawledForm[];
  /** Visible texts of buttons and links (main actions). */
  actions: string[];
}

/** Options of {@link crawlSite}. */
export interface CrawlOptions {
  /** First page; its host is always allowed. */
  startUrl: string;
  /** Extra hosts the crawl may visit (exact host or parent domain, like the environment's `allowDomains`). */
  allowDomains?: string[];
  /** Page budget. Default 20. */
  maxPages?: number;
  /** Navigation timeout per page in ms. Default 15 000. */
  timeoutMs?: number;
}

/** Result of {@link crawlSite}. */
export interface CrawlResult {
  pages: CrawledPage[];
  /** Links that were not visited, with the reason. */
  skipped: Array<{ url: string; reason: string }>;
}

const SKIP_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|mp4|mp3|css|js|json|xml|woff2?)$/i;
/** Links that would change state or end the session even as a GET. */
const RISKY_PATH = /(?:log-?out|sign-?out|delete|remove|unsubscribe|destroy)/i;

/** Whether `host` is `baseHost` or one of `allowDomains` (exact or subdomain). */
export function isAllowedHost(host: string, baseHost: string, allowDomains: readonly string[]): boolean {
  const h = host.toLowerCase();
  if (h === baseHost.toLowerCase()) return true;
  return allowDomains.some((d) => {
    const dom = d.trim().toLowerCase().replace(/^\*\./, '');
    return dom !== '' && (h === dom || h.endsWith(`.${dom}`));
  });
}

/** Resolves `href` against `from`, drops the fragment; undefined for non-http(s) or unparsable links. */
export function normalizeLink(href: string, from: string): string | undefined {
  try {
    const u = new URL(href, from);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Runs in the page: collects headings, forms, actions and links. Reads text only, never interacts. */
const EXTRACT = `(() => {
  const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const labelOf = (el) => {
    const id = el.getAttribute('id');
    const byFor = id ? document.querySelector('label[for="' + id.replace(/"/g, '') + '"]') : null;
    const wrap = el.closest('label');
    const l = byFor || wrap;
    return (l ? text(l) : '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('type') || 'field';
  };
  const forms = [...document.querySelectorAll('form')].slice(0, 10).map((f) => {
    const fields = [...f.querySelectorAll('input,select,textarea')]
      .filter((i) => !['hidden', 'submit', 'button'].includes((i.getAttribute('type') || '').toLowerCase()))
      .slice(0, 15).map(labelOf);
    const btn = f.querySelector('button[type=submit],button:not([type]),input[type=submit]');
    const submit = btn ? (text(btn) || btn.getAttribute('value') || '') : '';
    return submit ? { fields, submit } : { fields };
  });
  const actions = [...document.querySelectorAll('button,a[href],[role=button]')].map(text).filter(Boolean);
  return {
    title: document.title || '',
    headings: [...document.querySelectorAll('h1,h2')].slice(0, 6).map(text).filter(Boolean),
    forms,
    actions: [...new Set(actions)].slice(0, 20),
    links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || ''),
  };
})()`;

interface Extracted {
  title: string;
  headings: string[];
  forms: CrawledForm[];
  actions: string[];
  links: string[];
}

/**
 * Breadth-first, read-only crawl of one site. Never clicks or submits anything: every non-GET request is aborted,
 * document navigations outside the start host / `allowDomains` are aborted, and state-changing looking links
 * (logout, delete, ...) are not followed. Returns a per-page summary for System 2 to suggest tests from.
 */
export async function crawlSite(browser: Browser, opts: CrawlOptions): Promise<CrawlResult> {
  const start = new URL(opts.startUrl);
  const allow = opts.allowDomains ?? [];
  const max = Math.max(1, opts.maxPages ?? 20);
  const allowed = (url: string): boolean => {
    try {
      return isAllowedHost(new URL(url).hostname, start.hostname, allow);
    } catch {
      return false;
    }
  };
  const context = await browser.newContext({ acceptDownloads: false });
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return route.abort();
    if (req.isNavigationRequest() && !allowed(req.url())) return route.abort();
    return route.continue();
  });
  const pages: CrawledPage[] = [];
  const skipped: CrawlResult['skipped'] = [];
  const first = normalizeLink(opts.startUrl, opts.startUrl) ?? opts.startUrl;
  const seen = new Set<string>([first]);
  const queue: string[] = [first];
  try {
    const page = await context.newPage();
    while (queue.length > 0 && pages.length < max) {
      const url = queue.shift() as string;
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 15_000 });
        if (response && response.status() >= 400) {
          skipped.push({ url, reason: `HTTP ${response.status()}` });
          continue;
        }
        const data = (await page.evaluate(EXTRACT)) as Extracted;
        const here = page.url();
        if (!allowed(here)) {
          skipped.push({ url, reason: 'redirected outside the allowed domains' });
          continue;
        }
        pages.push({ url: here, title: data.title, headings: data.headings, forms: data.forms, actions: data.actions });
        for (const href of data.links) {
          const link = normalizeLink(href, here);
          if (!link || seen.has(link)) continue;
          seen.add(link);
          const u = new URL(link);
          if (!allowed(link)) skipped.push({ url: link, reason: 'outside allowed domains' });
          else if (SKIP_EXTENSIONS.test(u.pathname)) skipped.push({ url: link, reason: 'not a page' });
          else if (RISKY_PATH.test(u.pathname)) skipped.push({ url: link, reason: 'state-changing link' });
          else queue.push(link);
        }
      } catch (error) {
        skipped.push({ url, reason: error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed' });
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  for (const url of queue) skipped.push({ url, reason: 'page budget reached' });
  return { pages, skipped };
}
