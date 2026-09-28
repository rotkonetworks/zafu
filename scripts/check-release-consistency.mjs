#!/usr/bin/env node
/**
 * check-release-consistency.mjs — fail a PR that leaves the app version or the
 * user-facing changelog out of step.
 *
 * The zafu app version is the Chrome extension's release version, mirrored in
 * exactly three source files (they must always stay in lockstep), and every
 * release must be recorded in the root CHANGELOG.md. Both are easy to forget;
 * this gate fails fast and names the exact fix. Zero dependencies on purpose so
 * it can run in CI with no install step.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// package.json first: its version is the release version the changelog must carry.
const VERSION_FILES = [
  'apps/extension/package.json',
  'apps/extension/public/manifest.json',
  'apps/extension/public/beta-manifest.json',
];

const readVersion = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')).version;

const fail = (lines) => {
  console.error('zafu release consistency check failed.\n');
  for (const line of lines) console.error(line);
  console.error('\nFix:');
  console.error('  1. Run ./scripts/bump-version.sh <version> to set one version everywhere.');
  console.error('  2. Add a `## <version>` section to CHANGELOG.md.');
  process.exit(1);
};

const versions = VERSION_FILES.map((rel) => [rel, readVersion(rel)]);
const unique = new Set(versions.map(([, v]) => v));

if (unique.size > 1) {
  const width = Math.max(...versions.map(([rel]) => rel.length));
  fail([
    'The three version files disagree:',
    ...versions.map(([rel, v]) => `  ${rel.padEnd(width)}  ${v}`),
  ]);
}

const version = versions[0][1];

const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$`, 'm');

if (!heading.test(changelog)) {
  fail([`CHANGELOG.md has no \`## ${version}\` section.`]);
}

console.log(`OK: version ${version} is consistent across ${VERSION_FILES.length} files and CHANGELOG.md.`);
