/**
 * The guard only works if it is installed before anything else runs, in every
 * realm. These checks read the build config and the manifest, so a new entry,
 * worker or content script cannot ship without the guard - or, for a script in
 * the page's own world, with any network call at all.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const src = join(root, 'src');
const read = (p: string) => readFileSync(p, 'utf8');

/** `name: path.join(dirVar, 'a', 'b.ts')` entries, resolved against the known dirs. */
const DIRS: Record<string, string> = {
  injectDir: join(src, 'content-scripts'),
  entryDir: join(src, 'entry'),
  srcDir: src,
  workersDir: join(src, 'workers'),
};
const entries = [
  ...read(join(root, 'webpack.config.ts')).matchAll(
    /['\w/-]+:\s*path\.join\((\w+),\s*((?:'[^']+',?\s*)+)\)/g,
  ),
].flatMap(([, dir, parts]) => {
  const base = DIRS[dir!];
  const rel = [...parts!.matchAll(/'([^']+)'/g)].map(m => m[1]!);
  return base && /\.tsx?$/.test(rel.at(-1)!) ? [join(base, ...rel)] : [];
});

const manifest = JSON.parse(read(join(root, 'public/manifest.json'))) as {
  content_scripts: { js: string[]; world?: string }[];
};
const mainWorld = new Set(
  manifest.content_scripts
    .filter(c => c.world === 'MAIN')
    .flatMap(c => c.js.map(j => j.replace(/\.js$/, ''))),
);

const firstImport = (file: string) => /^import\s+['"]([^'"]+)['"];?$/m.exec(read(file))?.[1];
const imports = (file: string) =>
  [...read(file).matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]!);

describe('every webpack entry installs the egress guard first', () => {
  it('finds the entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of entries) {
    const name = file.slice(src.length + 1).replace(/\.tsx?$/, '');
    const isMain = mainWorld.has(name.replace(/^content-scripts\//, ''));
    it(`${name}${isMain ? ' (page world: no guard, no network)' : ''}`, () => {
      const first = imports(file)[0];
      if (isMain) {
        // A MAIN-world script shares the page's globals: patching them would
        // break the page, so instead it must not touch the network at all.
        const seen = new Set<string>();
        const walk = (f: string) => {
          if (seen.has(f)) {
            return;
          }
          seen.add(f);
          expect(read(f)).not.toMatch(
            /\bfetch\(|new WebSocket|EventSource|XMLHttpRequest|sendBeacon/,
          );
          for (const spec of imports(f).filter(s => s.startsWith('.'))) {
            const base = resolve(dirname(f), spec);
            const hit = ['.ts', '.tsx', '/index.ts'].map(ext => base + ext).find(existsSync);
            if (hit) {
              walk(hit);
            }
          }
        };
        walk(file);
        return;
      }
      expect(first).toMatch(/\/net\/egress-install(-lite)?$/);
      expect(firstImport(file)).toBe(first);
      // the lite guard has no storage and waits for a table: storage realms must use the full one
      const wantsFull = /^(service-worker|entry\/(page|popup|buy)-root)$/.test(name);
      expect(first!.endsWith('-lite')).toBe(!wantsFull);
    });
  }
});
