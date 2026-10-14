// Sets the release version in the root package.json and apps/cli/package.json (the published `s1pilot` package).
// They must match: the CLI test and the release workflow check it.
//
//   pnpm release:version 0.3.1
/* global process, URL */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write('Usage: pnpm release:version <x.y.z>\n');
  process.exit(1);
}

for (const file of ['package.json', 'apps/cli/package.json']) {
  const path = new URL(`../${file}`, import.meta.url);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error(`No version field in ${file}`);
  writeFileSync(path, next);
  process.stdout.write(`${file}: ${version}\n`);
}

process.stdout.write(`
Next: add a "## ${version}" entry to CHANGELOG.md, then
  git commit -am "chore: release ${version}" && git push origin master
  git tag v${version} && git push origin v${version}\n`);
