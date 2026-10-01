#!/usr/bin/env node
/**
 * Regenerates the bundled registry icons from the bundled @penumbrafi/registry
 * (penumbra-1), so the build ships them and never fetches one:
 *
 *   node scripts/gen-registry-icons.mjs        (from apps/extension; needs magick + rsvg-convert)
 *
 * The set is what the registry itself marks live: every asset reachable over an
 * IBC connection whose `status` is 'active' (plus native and delegation tokens,
 * whose images are the validators'), the images of those active chains, and
 * the rpcs, frontends and wallets in the registry globals. Assets with a
 * `priorityScore` on a since-expired channel ride along, so a legacy holding
 * of a major keeps its icon. Each image is downloaded once, reduced to a 64px
 * png (or kept as a small, scrubbed svg) and named by a hash of its url; the
 * manifest and shared/components/registry-icons.ts are rewritten to match and
 * any file no longer referenced is removed. Commit the result.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ChainRegistryClient } from '@penumbrafi/registry';
import * as prettier from 'prettier';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/assets/registry-icons');
const RESOLVER = path.join(ROOT, 'src/shared/components/registry-icons.ts');
const PX = 64;
const SVG_MAX = 4096;

const client = new ChainRegistryClient();
const reg = client.bundled.get('penumbra-1');
const globals = client.bundled.globals();

const channelOf = base => /^transfer\/(channel-\d+)\//.exec(base)?.[1];
const active = new Set(reg.ibcConnections.filter(c => c.status === 'active').map(c => c.channelId));
const live = m => {
  const ch = channelOf(m.base);
  return !ch || active.has(ch) || m.priorityScore > 0n;
};

/** each image as the urls that name it; AssetIcon reads png first, RegistryIcon svg first */
const images = [
  ...reg
    .getAllAssets()
    .filter(live)
    .flatMap(m => m.images),
  ...reg.ibcConnections.filter(c => c.status === 'active').flatMap(c => c.images),
  ...[...globals.rpcs, ...globals.frontends, ...globals.wallets].flatMap(e => e.images),
]
  .map(i => [i.png, i.svg].filter(Boolean))
  .filter(urls => urls.length);

const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

/** svg without anything that runs or reaches out: scripts, foreign objects, handlers, external refs */
const scrub = svg =>
  svg
    .replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->/gi, '')
    .replace(/<(script|foreignObject|metadata)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject)[^>]*\/>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/>\s+</g, '><')
    .trim();
const unsafe = svg => /<(script|foreignObject|image|iframe)|javascript:|url\((?!#)/i.test(svg);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zafu-icons-'));
const fetchOnce = async url => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

const toPng = (src, ext) => {
  const inFile = path.join(tmp, `in.${ext}`);
  const outFile = path.join(tmp, 'out.png');
  fs.writeFileSync(inFile, src);
  if (ext === 'svg') {
    execFileSync('rsvg-convert', ['-w', `${PX}`, '-h', `${PX}`, '-a', '-o', outFile, inFile]);
  } else {
    execFileSync('magick', [inFile, '-resize', `${PX}x${PX}>`, '-strip', outFile]);
  }
  return fs.readFileSync(outFile);
};

/** the smallest faithful local file for one image: a small svg as is, anything else a png */
const build = async urls => {
  const svgUrl = urls.find(u => u.endsWith('.svg'));
  if (svgUrl) {
    const svg = scrub((await fetchOnce(svgUrl)).toString('utf8'));
    if (svg.length <= SVG_MAX && !unsafe(svg)) {
      return { ext: 'svg', data: Buffer.from(svg) };
    }
  }
  const pngUrl = urls.find(u => !u.endsWith('.svg'));
  return pngUrl
    ? { ext: 'png', data: toPng(await fetchOnce(pngUrl), 'png') }
    : { ext: 'png', data: toPng(await fetchOnce(svgUrl), 'svg') };
};

const main = async () => {
  const byKey = new Map();
  for (const urls of images) {
    const known = [...byKey.values()].find(e => urls.some(u => e.urls.has(u)));
    if (known) {
      urls.forEach(u => known.urls.add(u));
    } else {
      byKey.set(urls[0], { urls: new Set(urls) });
    }
  }

  const manifest = {};
  const failed = [];
  for (const [key, entry] of byKey) {
    try {
      const { ext, data } = await build([...entry.urls]);
      const file = `${hash(key)}.${ext}`;
      fs.writeFileSync(path.join(OUT, file), data);
      entry.urls.forEach(u => (manifest[u] = file));
    } catch (e) {
      failed.push(`${key}: ${e.message}`);
    }
  }

  const files = new Set(Object.values(manifest));
  for (const f of fs.readdirSync(OUT)) {
    if (f !== 'manifest.json' && !files.has(f)) {
      fs.rmSync(path.join(OUT, f));
    }
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)));
  const pretty = async (file, text) =>
    fs.writeFileSync(
      file,
      await prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file }),
    );
  await pretty(path.join(OUT, 'manifest.json'), JSON.stringify(sorted));

  const id = f => `i${f.replace(/\..*$/, '')}`;
  const ts = [
    '// generated by scripts/gen-registry-icons.mjs from @penumbrafi/registry - do not edit',
    "import { setBundledIconResolver } from '@repo/ui/components/ui/asset-icon/bundled-icons';",
    ...[...files].sort().map(f => `import ${id(f)} from '../../assets/registry-icons/${f}';`),
    '',
    'const BY_URL: Record<string, string> = {',
    ...Object.entries(sorted).map(([u, f]) => `  '${u}': ${id(f)},`),
    '};',
    '',
    '/** the registry icons this build ships; any other url falls back to a monogram */',
    'export const installRegistryIcons = (): void => {',
    '  setBundledIconResolver((url: string) => BY_URL[url]);',
    '};',
    '',
  ].join('\n');
  await pretty(RESOLVER, ts);
  fs.rmSync(tmp, { recursive: true, force: true });

  const bytes = [...files].reduce((t, f) => t + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(
    `${files.size} icons, ${Object.keys(sorted).length} urls, ${(bytes / 1024).toFixed(0)} KiB`,
  );
  failed.forEach(f => console.warn(`skipped ${f}`));
};

await main();
