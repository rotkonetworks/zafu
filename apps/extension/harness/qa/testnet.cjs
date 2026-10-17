// testnet rig: a ZAFU_TESTNET=1 build against tzcash.rotko.net, with persistent profiles whose
// seeds sit in <tnDir>/seed*.txt (mode 600, never printed). TAZ only, never mainnet.
const path = require('path'),
  fs = require('fs');
const L = require('./lib.cjs');

const NODE = 'https://tzcash.rotko.net';
const FAUCET = 'https://faucet.testnet.valargroup.dev';

// grpc-web GetTip, empty request; field 1 is the height
const getTip = async () => {
  const r = await fetch(`${NODE}/zidecar.v1.Zidecar/GetTip`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: new Uint8Array(5),
  });
  const b = new Uint8Array(await r.arrayBuffer());
  let i = 6,
    h = 0,
    s = 0;
  for (;;) {
    const x = b[i++];
    h += (x & 0x7f) * 2 ** s;
    s += 7;
    if (!(x & 0x80)) {
      return h;
    }
  }
};

const secret = (dir, n) => fs.readFileSync(path.join(dir, n), 'utf8').trim();

// the scanned height the worker last logged
const scanned = z => {
  const b = z.logs(/\[zcash-worker\] blocks \d+\.\.\d+/).pop();
  return b ? +b.text.match(/\.\.(\d+)/)[1] : 0;
};

// sync runs while a zafu screen is open and unlocked
const syncToTip = async (z, ms = 15 * 60_000) => {
  const t0 = Date.now();
  const home = await z.open('/');
  await z.unlock(home);
  for (;;) {
    const tip = await getTip().catch(() => 0);
    if (tip && scanned(z) >= tip - 1) {
      await home.close();
      return tip;
    }
    if (Date.now() - t0 > ms) {
      throw new Error(`sync stuck at ${scanned(z)} / ${tip}`);
    }
    await L.sleep(5000);
  }
};

const setNode = async (z, url = NODE) => {
  const s = await z.open('/settings/networks/zcash?sheet=node');
  await z.unlock(s);
  await L.clickText(s, 'your own node');
  await s.locator('input[placeholder="https://..."]').fill(url);
  await L.clickText(s, 'use this node');
  await s.waitForTimeout(2500);
  await s.close();
};

// one-time per profile: import, birthday near the testnet tip, node, sync
const setup = async (z, dir, seedFile) => {
  const tip = await getTip();
  const birthday = Math.floor((tip - 500) / 100) * 100;
  // the node first, so the very first sync never asks mainnet for a testnet height
  await z.set({ networkEndpoints: { zcash: NODE } });
  await L.importSeed(z, secret(dir, seedFile), { password: z.password, birthday });
  // the onboarding birthday is clamped to mainnet heights; set the testnet one directly
  await z.sw().evaluate(async b => {
    const all = await chrome.storage.local.get(null);
    const ks = Object.keys(all).filter(k => k.startsWith('zcashBirthday_'));
    await chrome.storage.local.set(Object.fromEntries(ks.map(k => [k, b])));
  }, birthday);
  // the personalize step writes its own (default) node back; set ours again, as a person would
  await setNode(z);
  return birthday;
};

// the receive screen's shielded address, and the transparent one if asked
const addresses = async (z, o = {}) => {
  const r = await z.open('/receive', 'popup.html', 5000);
  await z.unlock(r);
  await r.waitForTimeout(2000);
  const ua = ((await L.text(r)).match(/utest1[0-9a-z]+/) ?? [])[0];
  let tm;
  if (o.transparent) {
    await L.clickText(r, 'transparent').catch(() => undefined);
    await r.waitForTimeout(4000);
    tm = ((await L.text(r)).match(/\btm[1-9A-HJ-NP-Za-km-z]{33}\b/) ?? [])[0];
  }
  await r.close();
  return { ua, tm };
};

const faucetClaim = async address => {
  const r = await fetch(`${FAUCET}/api/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  return { status: r.status, body: await r.text() };
};

// zidecar GetTransaction: the mined height, 0 in mempool, undefined if unknown
const txHeight = async txid => {
  const id = Buffer.from(txid, 'hex').reverse();
  const msg = Buffer.concat([Buffer.from([0x0a, 32]), id]);
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, msg.length]), msg]);
  const r = await fetch(`${NODE}/zidecar.v1.Zidecar/GetTransaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: frame,
  });
  const b = Buffer.from(await r.arrayBuffer());
  if (b[0] !== 0 || b.length < 6) {
    return undefined;
  }
  // field 2 (height) varint, after field 1 (data bytes)
  let i = 5;
  while (i < b.length) {
    const tag = b[i++];
    if (tag === 0x0a) {
      let len = 0,
        s = 0;
      for (;;) {
        const x = b[i++];
        len += (x & 0x7f) * 2 ** s;
        s += 7;
        if (!(x & 0x80)) {
          break;
        }
      }
      i += len;
    } else if (tag === 0x10) {
      let h = 0,
        s = 0;
      for (;;) {
        const x = b[i++];
        h += (x & 0x7f) * 2 ** s;
        s += 7;
        if (!(x & 0x80)) {
          return h;
        }
      }
    } else {
      return undefined;
    }
  }
  return 0;
};

module.exports = {
  NODE,
  getTip,
  secret,
  scanned,
  syncToTip,
  setNode,
  setup,
  addresses,
  faucetClaim,
  txHeight,
};
