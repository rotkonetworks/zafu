#!/usr/bin/env node
// Bundle the crosschain swap picker's token and chain logos, so opening the
// picker never fetches an image (that would tell a logo host which tokens a
// wallet looks at).
//
//   node scripts/gen-swap-icons.mjs [cache-dir]
//
// Tokens: the 1Click token list -> coingeckoId -> CoinGecko image, one logo per
// symbol. Chains: the Trust Wallet assets repo, else the chain's native coin.
// A cache dir of earlier downloads (<coingeckoId>.* / <chain>.* under tokens/
// and chains/) skips the network for logos already fetched.
// Writes src/assets/swap-icons/*.png and src/state/swap/icons.ts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/assets/swap-icons');
const MODULE = path.join(ROOT, 'src/state/swap/icons.ts');
const CACHE = process.argv[2];
const PX = 64;
const UA = { 'User-Agent': 'Mozilla/5.0 (zafu icon bundling)' };

// 1Click chain code -> [Trust Wallet dir, CoinGecko id of the native coin]
const CHAINS = {
  eth: ['ethereum', 'ethereum'],
  btc: ['bitcoin', 'bitcoin'],
  sol: ['solana', 'solana'],
  near: ['near', 'near'],
  base: ['base', null],
  arb: ['arbitrum', 'arbitrum'],
  op: ['optimism', 'optimism'],
  pol: ['polygon', 'polygon-ecosystem-token'],
  bsc: ['smartchain', 'binancecoin'],
  avax: ['avalanchec', 'avalanche-2'],
  gnosis: ['xdai', 'gnosis'],
  aptos: ['aptos', 'aptos'],
  sui: ['sui', 'sui'],
  ton: ['ton', 'the-open-network'],
  tron: ['tron', 'tron'],
  stellar: ['stellar', 'stellar'],
  xrp: ['ripple', 'ripple'],
  cardano: ['cardano', 'cardano'],
  doge: ['doge', 'dogecoin'],
  ltc: ['litecoin', 'litecoin'],
  bch: ['bitcoincash', 'bitcoin-cash'],
  dash: ['dash', 'dash'],
  zec: ['zcash', 'zcash'],
  starknet: ['starknet', 'starknet'],
  scroll: ['scroll', 'scroll'],
  monad: ['monad', 'monad'],
  bera: ['berachain', 'berachain-bera'],
  hypercore: ['hyperliquid', 'hyperliquid'],
  xlayer: ['xlayer', 'okb'],
  plasma: [null, 'plasma'],
  aleo: ['aleo', 'aleo'],
  movement: [null, 'movement'],
  gaia: ['cosmos', 'cosmos'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zafu-swap-icons-'));

const fetchBytes = async url => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) {
      return Buffer.from(await r.arrayBuffer());
    }
    if (r.status !== 429) {
      return undefined;
    }
    await sleep(20_000 * (attempt + 1));
  }
  return undefined;
};

const cached = (kind, key) => {
  if (!CACHE) {
    return undefined;
  }
  const dir = path.join(CACHE, kind);
  const hit = fs.existsSync(dir) && fs.readdirSync(dir).find(f => f.startsWith(`${key}.`));
  return hit ? fs.readFileSync(path.join(dir, hit)) : undefined;
};

const toPng = (data, dest) => {
  const inFile = path.join(tmp, 'in');
  fs.writeFileSync(inFile, data);
  execFileSync('magick', [inFile, '-resize', `${PX}x${PX}`, '-strip', dest]);
};

const coingeckoImages = async ids => {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).join(',');
    const body = await fetchBytes(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${batch}`,
    );
    for (const c of body ? JSON.parse(body.toString()) : []) {
      out[c.id] = c.image;
    }
    await sleep(5_000);
  }
  return out;
};

const tokens = await (await fetch('https://1click.chaindefuser.com/v0/tokens')).json();

// one logo per symbol: the native chain's token, else the first with an id
const idBySymbol = new Map();
for (const t of [...tokens].sort(
  (a, b) =>
    Number(b.blockchain === b.symbol.toLowerCase()) -
    Number(a.blockchain === a.symbol.toLowerCase()),
)) {
  if (t.coingeckoId && t.symbol !== 'ZEC' && !idBySymbol.has(t.symbol.toLowerCase())) {
    idBySymbol.set(t.symbol.toLowerCase(), t.coingeckoId);
  }
}
for (const [chain, [, cg]] of Object.entries(CHAINS)) {
  // chain natives thorchain lists that 1Click may not (atom, ...)
  if (cg && chain !== 'zec' && !idBySymbol.has(chain)) {
    idBySymbol.set(chain, cg);
  }
}

const wanted = [...idBySymbol.values(), ...Object.values(CHAINS).map(([, cg]) => cg)].filter(
  (id, i, all) => id && all.indexOf(id) === i && !cached('tokens', id),
);
const images = wanted.length ? await coingeckoImages(wanted) : {};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const token = {};
for (const [symbol, id] of idBySymbol) {
  const data = cached('tokens', id) ?? (images[id] && (await fetchBytes(images[id])));
  if (data) {
    toPng(data, path.join(OUT, `t-${id}.png`));
    token[symbol] = `t-${id}`;
  }
}

const chain = {};
for (const [code, [tw, cg]] of Object.entries(CHAINS)) {
  const data =
    cached('chains', code) ??
    (tw &&
      (await fetchBytes(
        `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${tw}/info/logo.png`,
      ))) ??
    (cg && (cached('tokens', cg) ?? (images[cg] && (await fetchBytes(images[cg])))));
  if (data) {
    toPng(data, path.join(OUT, `c-${code}.png`));
    chain[code] = `c-${code}`;
  }
}

const files = [...new Set([...Object.values(token), ...Object.values(chain)])].sort();
const ident = f => f.replace(/[^a-z0-9]/gi, '_');
const entries = (m, indent = '  ') =>
  Object.keys(m)
    .sort()
    .map(k => `${indent}${JSON.stringify(k)}: ${ident(m[k])},`)
    .join('\n');

fs.writeFileSync(
  MODULE,
  `// generated by scripts/gen-swap-icons.mjs - do not edit
${files.map(f => `import ${ident(f)} from '../../assets/swap-icons/${f}.png';`).join('\n')}

/** token logos by lowercase symbol (one per symbol, every chain shares it) */
export const TOKEN_ICONS: Partial<Record<string, string>> = {
${entries(token)}
};

/** chain logos by near's chain code */
export const CHAIN_ICONS: Partial<Record<string, string>> = {
${entries(chain)}
};
`,
);
execFileSync('npx', ['prettier', '--write', MODULE], { stdio: 'ignore' });
console.log(`${Object.keys(token).length} token and ${Object.keys(chain).length} chain logos`);
