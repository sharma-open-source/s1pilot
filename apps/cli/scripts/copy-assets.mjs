// Copies the assets the bundled CLI needs at runtime next to it, so a packed tarball is self-contained:
//   dist/web   <- apps/web/dist       (served by `s1pilot ui`)
//   migrations <- packages/db/migrations (SQL migrations, resolved as ../migrations/<dialect> from dist/index.js)
//   profiles   <- profiles            (model capability profiles, resolved as ../profiles from dist/index.js)
//   README.md, LICENSE <- repository root (shown on the npm page)
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
/** Normalises permissions (a copy must stay readable whatever the source mode was). */
function normalise(path) {
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) normalise(join(path, name));
  } else {
    chmodSync(path, 0o644);
  }
}

const assets = [
  ['../../web/dist', '../dist/web'],
  ['../../../packages/db/migrations', '../migrations'],
  ['../../../profiles', '../profiles'],
];

for (const [from, to] of assets) {
  const src = here(from);
  if (!existsSync(src) || !existsSync(`${src}/${from.endsWith('dist') ? 'index.html' : ''}`)) {
    throw new Error(`Cannot bundle ${src}: build it first (pnpm build).`);
  }
  const dest = here(to);
  const tmp = `${dest}.tmp`;
  // Copy aside, then swap in, so an interrupted build never leaves a half-copied directory behind.
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, tmp, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  normalise(tmp);
  renameSync(tmp, dest);
}

// The npm page shows the package's own README; ship the repository README and LICENSE with the tarball.
for (const name of ['README.md', 'LICENSE']) {
  const dest = here(`../${name}`);
  cpSync(here(`../../../${name}`), dest);
  chmodSync(dest, 0o644);
}
