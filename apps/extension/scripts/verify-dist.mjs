#!/usr/bin/env node
/**
 * Post-build sanity check for a built extension directory (dist/, beta-dist/).
 *
 * For every HTML page, find the entry script's startup call
 * (`n.O(void 0,[ids...],...)`) - webpack runs the entry only after each of
 * those chunk ids has registered itself - and confirm each chunk file exists
 * and pushes that exact id onto the jsonp array.
 *
 * Why: the browser and worker compilations share one output directory. When a
 * worker chunk once got the same numeric id as a browser chunk it overwrote the
 * browser's file; the popup's entry then waited forever for a chunk that never
 * registered and rendered as a blank white screen - with no error anywhere.
 *
 * usage: node scripts/verify-dist.mjs dist [beta-dist ...]   (exit 1 on failure)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let failed = false;
const fail = msg => {
  failed = true;
  console.error(`verify-dist: ${msg}`);
};

for (const dir of process.argv.slice(2)) {
  const pages = readdirSync(dir).filter(f => f.endsWith('.html'));
  for (const page of pages) {
    const html = readFileSync(join(dir, page), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+\.js)"/g)].map(m => m[1]);
    for (const script of scripts) {
      const path = join(dir, script);
      if (!existsSync(path)) {
        fail(`${dir}/${page}: script ${script} is missing`);
        continue;
      }
      const src = readFileSync(path, 'utf8');
      // the entry's deferred startup: n.O(void 0,[7895,8570,88,5245],()=>n(98995))
      const startup = src.match(/\.O\(void 0,\[([\d,]*)\]/);
      if (!startup) {
        continue; // a chunk file, not an entry
      }
      const ids = startup[1].split(',').filter(Boolean);
      for (const id of ids) {
        const chunk = join(dir, `${id}.js`);
        if (!existsSync(chunk)) {
          fail(`${dir}/${page}: entry ${script} waits for chunk ${id}, but ${id}.js is missing`);
          continue;
        }
        const head = readFileSync(chunk, 'utf8').slice(0, 4096);
        if (!new RegExp(`\\.push\\(\\[\\[(?:[\\d,]*,)?${id}(?:,[\\d,]*)?\\]`).test(head)) {
          fail(
            `${dir}/${page}: entry ${script} waits for chunk ${id}, but ${id}.js does not register it ` +
              `(overwritten by another compilation?)`,
          );
        }
      }
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log(`verify-dist: ok (${process.argv.slice(2).join(', ')})`);
