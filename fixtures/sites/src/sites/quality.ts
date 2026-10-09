import type { SiteHandler } from '../context.js';
import { page } from '../html.js';

/**
 * `/quality`: a small page for the accessibility, console and network health checks (S-053). Query switches:
 * `?label=missing` renders an input without an accessible name (axe rule `label`), `?console=error` logs a
 * `console.error` and throws an uncaught error, `?status=503` makes the page fetch an endpoint that answers 503.
 * Without switches the page is clean.
 */
export const quality: SiteHandler = (ctx) => {
  if (ctx.path === '/api/health') {
    return ctx.sendJson({ ok: false }, 503);
  }
  if (ctx.path !== '/') return ctx.notFound();
  const q = ctx.url.searchParams;
  const input =
    q.get('label') === 'missing'
      ? '<input type="text" name="email">'
      : '<label for="email">Email</label><input id="email" type="text" name="email">';
  const scripts = [
    q.get('console') === 'error' ? `console.error('Fixture console failure'); setTimeout(() => { throw new Error('Fixture uncaught error'); }, 0);` : '',
    q.get('status') === '503' ? `fetch('/quality/api/health').catch(() => undefined);` : '',
  ]
    .filter(Boolean)
    .join('\n');
  ctx.html(
    page({
      title: 'Quality checks',
      site: 'Fixture Quality',
      nav: '<a href="/quality">Home</a>',
      flags: ctx.flags,
      body: `<h1>Newsletter</h1>
<form onsubmit="return false">${input}<button type="submit">Subscribe</button></form>`,
      ...(scripts ? { script: scripts } : {}),
    }),
  );
};
