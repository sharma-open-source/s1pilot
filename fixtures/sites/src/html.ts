import type { Flags } from './flags.js';

/** Escapes text for use in HTML content and attribute values. */
export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CSS = `
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: #1a1a1a; }
  header, main, footer { max-width: 760px; margin: 0 auto; padding: 12px 16px; }
  header { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; border-bottom: 1px solid #ddd; }
  nav { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
  a { color: #0b57d0; }
  button, input, select { font: inherit; min-height: 44px; padding: 4px 10px; box-sizing: border-box; }
  label { display: block; margin-top: 12px; }
  fieldset { margin: 12px 0; }
  fieldset label { display: inline-block; margin: 0 12px 0 0; }
  [role=alert] { color: #b3261e; }
  .toast { margin-top: 12px; padding: 8px 12px; background: #e6f4ea; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin: 8px 0; }
`;

export interface PageOptions {
  title: string;
  /** Site name shown in the header and used for the nav landmark label. */
  site: string;
  nav: string;
  flags: Flags;
  body: string;
  /** Page-specific inline script (runs after `window.__FX__` is defined). */
  script?: string;
}

/** Wraps page content in the shared document shell. */
export function page(opts: PageOptions): string {
  const fx = JSON.stringify({ bugs: [...opts.flags.bugs], variants: [...opts.flags.variants] });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <strong>${esc(opts.site)}</strong>
  <nav aria-label="Main">${opts.nav}</nav>
</header>
<main>
${opts.body}
</main>
<footer><small>Fixture site for s1-pilot tests. Not a real store.</small></footer>
<script>window.__FX__ = ${fx};</script>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`;
}
