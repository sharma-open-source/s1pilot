import type { Ctx, SiteHandler } from '../context.js';
import { esc, page } from '../html.js';

/** Loader styles of the `/slow` site, chosen with `?loader=`. */
export const LOADER_KINDS = ['busy', 'spinner', 'text', 'none'] as const;
export type LoaderKind = (typeof LOADER_KINDS)[number];

/** Longest delay the `/slow` site accepts (ms). */
const MAX_DELAY_MS = 30_000;

function ms(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_DELAY_MS) : fallback;
}

/**
 * Loader markup per kind: `busy` is an accessible status with `aria-busy`, `spinner` a CSS-only
 * animated element with a `spinner` class, `text` a bare "Loading…" line, `none` nothing at all.
 */
const LOADER: Record<LoaderKind, string> = {
  busy: '<div role="status" aria-busy="true">Please wait</div>',
  spinner: '<div class="spinner" aria-label="Please wait"></div>',
  text: '<p>Loading…</p>',
  none: '',
};

const CSS = `<style>
  .spinner { width: 24px; height: 24px; border: 3px solid #ddd; border-top-color: #0b57d0; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>`;

/** Shows the loader in `#id`, then replaces it with `html` after `delay` ms. */
function loaderScript(loader: LoaderKind, delay: number): string {
  return `window.fxLoad = function (id, html) {
  var el = document.getElementById(id);
  el.innerHTML = ${JSON.stringify(LOADER[loader])};
  setTimeout(function () { el.innerHTML = html; }, ${delay});
};`;
}

/**
 * `/slow`: a three-page flow with loaders, to test waiting. `/slow` → "Load orders" shows a loader,
 * then a "Next page" link → `/slow/details` (server answers after `?serve=` ms) shows a loader,
 * then a Name form → Save → `/slow/done` ("Order saved"). `?delay=` sets the loader time
 * (default 1500 ms) and `?loader=` its kind ({@link LOADER_KINDS}); both carry through the flow.
 */
export const slow: SiteHandler = async (ctx: Ctx) => {
  const q = ctx.url.searchParams;
  const delay = ms(q.get('delay'), 1500);
  const serve = ms(q.get('serve'), 0);
  const loader = (LOADER_KINDS as readonly string[]).includes(q.get('loader') ?? '') ? (q.get('loader') as LoaderKind) : 'busy';
  const qs = `?delay=${delay}&serve=${serve}&loader=${loader}`;
  const layout = (title: string, body: string, script?: string): string =>
    page({ title, site: 'Fixture Slow', nav: `<a href="/slow${esc(qs)}">Orders</a>`, flags: ctx.flags, body: `${CSS}${body}`, ...(script ? { script } : {}) });

  if (ctx.path === '/') {
    const link = `<a href="/slow/details${esc(qs)}">Next page</a>`;
    return ctx.html(
      layout(
        'Orders',
        `<h1>Orders</h1>
<button type="button" id="load">Load orders</button>
<div id="out"></div>`,
        `${loaderScript(loader, delay)}
document.getElementById('load').addEventListener('click', function () { fxLoad('out', ${JSON.stringify(link)}); });`,
      ),
    );
  }
  if (ctx.path === '/details') {
    await new Promise((resolve) => setTimeout(resolve, serve));
    const form = `<form action="/slow/done" method="get">
<input type="hidden" name="delay" value="${delay}"><input type="hidden" name="serve" value="${serve}"><input type="hidden" name="loader" value="${loader}">
<label>Name <input name="name" autocomplete="off"></label>
<button type="submit">Save</button>
</form>`;
    return ctx.html(layout('Details', '<h1>Details</h1><div id="form"></div>', `${loaderScript(loader, delay)}\nfxLoad('form', ${JSON.stringify(form)});`));
  }
  if (ctx.path === '/done') {
    return ctx.html(layout('Order saved', `<h1>Order saved</h1><p role="status">Saved for ${esc(q.get('name') ?? '')}</p>`));
  }
  ctx.notFound();
};
