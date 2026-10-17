// zcash sync and node, receive: z1-z6 r1-r3 (mainnet, fresh unfunded wallets)
const path = require('path');
const L = require('./lib.cjs');

const PNPM = path.resolve(__dirname, '../../../../node_modules/.pnpm');
const ZXING = path.join(
  PNPM,
  require('fs')
    .readdirSync(PNPM)
    .find(d => /^@zxing\+library@/.test(d)),
  'node_modules/@zxing/library/umd/index.min.js',
);

// the svg QR on screen, decoded in a blank page by zxing
const readQr = async (z, pg) => {
  const png = await pg.locator('svg[role=img]').first().screenshot();
  const dec = await z.ctx.newPage();
  await dec.addScriptTag({ path: ZXING });
  const v = await dec.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const pad = 40,
      cv = document.createElement('canvas');
    cv.width = img.width + 2 * pad;
    cv.height = img.height + 2 * pad;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, pad, pad);
    const d = g.getImageData(0, 0, cv.width, cv.height);
    const lum = new Uint8ClampedArray(cv.width * cv.height);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = (d.data[i * 4] + d.data[i * 4 + 1] + d.data[i * 4 + 2]) / 3;
    }
    // either polarity: a dark theme may draw light modules on dark
    for (const inv of [false, true]) {
      try {
        const src = new ZXing.RGBLuminanceSource(lum, cv.width, cv.height);
        const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(inv ? src.invert() : src));
        return new ZXing.QRCodeReader().decode(bmp).getText();
      } catch {}
    }
    return null;
  }, png.toString('base64'));
  await dec.close();
  return v;
};
const clip = pg => pg.evaluate(() => window.__copied?.at(-1) ?? 'nothing copied');
const shownAddr = async pg => ((await L.text(pg)).match(/\bu1[0-9a-z]{100,}/) ?? [])[0];

// one created wallet shared by z1-z3 and z6, opened once
let shared;
const wallet = async c => {
  if (!shared) {
    shared = await L.launch(c.dist);
    await L.createWallet(shared);
  }
  return shared;
};

const syncLines = async (z, pg, ms) => {
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = L.flat(await L.text(pg));
    const strip = (t.match(
      /syncing \d+% · .*?(?= balance)|up to date|offline.{0,60}|can't reach.{0,60}/,
    ) ?? [''])[0].trim();
    seen.push({ s: Math.round((Date.now() - t0) / 1000), strip });
    if (/up to date|synced/.test(strip) || (!/syncing/.test(t) && seen.length > 3)) {
      break;
    }
    await L.sleep(2000);
  }
  return seen;
};

module.exports = {
  z1: {
    title: 'first sync strip and finish',
    timeout: 900_000,
    run: async c => {
      // a created wallet starts at this month and is done in seconds; this one starts ~30k blocks back
      const z = await L.launch(c.dist);
      await L.importSeed(z, L.genPhrase(24), { birthday: 3_480_000 });
      const pg = await z.open('/', 'popup.html', 500);
      const seen = await syncLines(z, pg, 10 * 60_000).finally(() => undefined);
      await c.shot(pg, 'end');
      c.file('strip.json', seen);
      const counts = seen
        .map(x => +((x.strip.match(/([\d,]+) blocks/) ?? [])[1] ?? '').replace(/,/g, ''))
        .filter(n => n > 0);
      const pcts = seen.map(x => +((x.strip.match(/(\d+)%/) ?? [])[1] ?? -1)).filter(n => n >= 0);
      const eta = seen.some(x => /about \d+ ?(s|sec|min|h)/.test(x.strip));
      const done =
        /up to date|synced/.test(seen.at(-1).strip) || !/syncing/.test(L.flat(await L.text(pg)));
      const fell =
        (counts.length >= 2 && counts[0] > counts.at(-1)) ||
        (pcts.length >= 2 && pcts.at(-1) > pcts[0]);
      await z.close();
      return {
        status: done && fell && eta ? 'pass' : 'fail',
        note: `import with birthday 3,480,000; strip went "${seen[0]?.strip}" -> "${seen.at(-1)?.strip}" in ${seen.at(-1)?.s}s; blocks-left ${JSON.stringify(counts.slice(0, 3))}, percent ${JSON.stringify(pcts.filter((_, i) => i % 5 === 0))}; eta shown: ${eta}; finished: ${done} (${c.dir}/strip.json, end.png)`,
      };
    },
  },

  z2: {
    title: 'chain checked row',
    run: async c => {
      const z = await wallet(c);
      let t = '';
      for (let i = 0; i < 12; i++) {
        const pg = await z.open('/settings/networks/zcash', 'popup.html', 2500);
        t = L.flat(await L.text(pg));
        await c.shot(pg, 'node');
        await pg.close();
        if (/chain checked|proof of work/.test(t) && !/chain not verified/.test(t)) {
          break;
        }
        await L.sleep(10000);
      }
      const row = (t.match(/node \S+ (up to date|syncing)[^?]*\?[^?]*?(?= rotko| server)/) ?? [
        t.slice(t.indexOf('node'), t.indexOf('node') + 160),
      ])[0];
      const ok =
        /checked/.test(row) &&
        /proof of work/.test(t) &&
        /block [\d,]+/.test(row) &&
        !/not verified/.test(row);
      return {
        status: ok ? 'pass' : 'fail',
        note: `node rows after sync (2 min of retries): "${row}" (${c.dir}/node.png)`,
      };
    },
  },

  z3: {
    title: 'node server and connection rows',
    run: async c => {
      const z = await wallet(c);
      const pg = await z.open('/settings/networks/zcash', 'popup.html', 3000);
      await c.shot(pg, 'node');
      const t = L.flat(await L.text(pg));
      const server = (t.match(/server \? ([^?]*?)(?= connection)/) ?? [])[1] ?? '';
      const conn = (t.match(/connection \? ([^?]*?)(?= starts from)/) ?? [])[1] ?? '';
      const ok =
        /zidecar · \d+\.\d+\.\d+/.test(server) &&
        /zebra|zakura|zcashd/i.test(server) &&
        /HTTP\/\d|h2|h3|quic/i.test(conn);
      return {
        status: ok ? 'pass' : 'fail',
        note: `server row "${server}"; connection row "${conn}" (${c.dir}/node.png)`,
      };
    },
  },

  z6: {
    title: 'settings name only zcash/penumbra, never ibc chains',
    run: async c => {
      const z = await wallet(c);
      const out = {};
      for (const [k, net] of Object.entries({
        zcashOnly: ['zcash'],
        both: ['zcash', 'penumbra'],
      })) {
        await z.set({ enabledNetworks: net });
        for (const r of ['/settings', '/settings/devices', '/settings/wallets']) {
          const pg = await z.open(r, 'popup.html', 2000);
          out[`${k} ${r}`] = L.flat(await L.text(pg));
          await c.shot(pg, `${k}${r.replace(/\//g, '_')}`);
          await pg.close();
        }
      }
      await z.set({ enabledNetworks: ['zcash'] });
      c.file('texts.json', out);
      const IBC =
        /\b(osmosis|noble|cosmos ?hub|injective|celestia|neutron|stride|dydx|axelar|nomic)\b/i;
      const ibc = Object.entries(out)
        .filter(([, t]) => IBC.test(t))
        .map(([k, t]) => `${k}: ${t.match(IBC)[0]}`);
      const penOff = /penumbra/.test(
        out['zcashOnly /settings'] + out['zcashOnly /settings/devices'],
      );
      return {
        status: !ibc.length && !penOff ? 'pass' : 'fail',
        note: `settings home + wallets and devices + wallets, zcash-only and zcash+penumbra: ibc chain names ${ibc.length ? ibc.join('; ') : 'none'}; penumbra named while off: ${penOff} (${c.dir}/texts.json)`,
      };
    },
  },

  z4: {
    title: 'own node / lightwalletd detection, nym row direct',
    timeout: 400_000,
    run: async c => {
      const z = await wallet(c);
      const T = require('./testnet.cjs');
      const LWD = 'https://zec.rocks:443';
      const before = await z.storage();
      await T.setNode(z, LWD);
      await L.sleep(15000);
      const pg = await z.open('/settings/networks/zcash', 'popup.html', 4000);
      await c.shot(pg, 'lwd-node');
      const t = L.flat(await L.text(pg));
      const nym = await z.open('/settings/network/connections', 'popup.html', 1500);
      await nym
        .getByRole('button', { name: /^nym, per network/ })
        .first()
        .click();
      await nym.waitForTimeout(1500);
      await c.shot(nym, 'nym-per-network');
      const nt = L.flat(await L.text(nym));
      const sheet = nt.slice(nt.lastIndexOf('keep nym ready while unlocked'));
      const zrow = (sheet.match(/zcash .{0,70}/) ?? ['(no zcash row found)'])[0];
      const st = await z.storage();
      // back to the default node
      await z.set({ networkEndpoints: before.networkEndpoints ?? {} });
      c.file('texts.json', {
        node: t,
        nym: nt,
        backends: st.zcashBackends,
        backend: st.zcashBackend,
      });
      const kind = /lightwalletd|zaino/i.test(t);
      const hidden = !/memo decoys|see payments before they're mined/.test(t);
      const marked = (t.match(/needs a zidecar node/g) ?? []).length;
      const direct = /direct/.test(zrow);
      return {
        // decided: zidecar-only rows may stay, disabled, saying "needs a zidecar node"
        status: kind && direct && (hidden || marked >= 2) ? 'pass' : 'fail',
        note: `node ${LWD}: kind shown as lightwalletd/zaino: ${kind}; zidecar-only rows hidden: ${hidden}${hidden ? '' : ` (they stay, ${marked} marked "needs a zidecar node")`}; stored backend ${JSON.stringify(st.zcashBackends ?? st.zcashBackend)}; nym per-network zcash row "${zrow.slice(0, 100)}" says direct: ${direct} (${c.dir}/lwd-node.png, nym-per-network.png, texts.json)`,
      };
    },
  },

  z5: {
    title: 'offline then resume',
    timeout: 600_000,
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        // a longer sync, so going offline lands mid-way
        await L.importSeed(z, L.genPhrase(24), { birthday: 3_440_000 });
        const pg = await z.open('/', 'popup.html', 1000);
        for (let i = 0; i < 60 && scannedOf(z) < 3_445_000; i++) {
          await L.sleep(1000);
        }
        await z.offline(true);
        const tOff = Date.now();
        const h0 = scannedOf(z);
        await L.sleep(45000);
        const off = L.flat(await L.text(pg));
        await c.shot(pg, 'offline');
        const hOff = scannedOf(z);
        await z.offline(false);
        await L.sleep(60000);
        const hBack = scannedOf(z);
        const back = L.flat(await L.text(pg));
        await c.shot(pg, 'back');
        const calm =
          /offline|can't reach|not reach|connection|waiting/i.test(off) &&
          !/error|failed|fatal/i.test(off);
        const resumed = hBack > hOff && hOff - h0 < 2000;
        return {
          status: calm && resumed ? 'pass' : 'fail',
          note: `offline (CDP offline on every realm, proxy refusing and tunnels dropped) for 45s mid-sync (scanned ${h0} -> ${hOff}); screen said "${(off.match(/(syncing|offline|can't reach|waiting)[^|]{0,90}/) ?? [off.slice(0, 90)])[0]}"; after reconnect scanned ${hOff} -> ${hBack} in 60s without a tap: "${(back.match(/(syncing|up to date)[^|]{0,60}/) ?? [''])[0]}" (${c.dir}/offline.png, back.png); off ${Math.round((Date.now() - tOff) / 1000)}s`,
        };
      } finally {
        await z.close();
      }
    },
  },

  r1: {
    title: 'fresh shielded address per show/copy, QR == copied',
    run: async c => {
      const z = await wallet(c);
      const seen = [];
      const pg = await z.open('/receive', 'popup.html', 3500);
      await z.hookCopy(pg);
      const a1 = await shownAddr(pg);
      const q1 = await readQr(z, pg);
      await L.button(pg, 'copy address').click();
      await pg.waitForTimeout(800);
      const c1 = await clip(pg);
      await pg.waitForTimeout(2500);
      const a2 = await shownAddr(pg);
      const q2 = await readQr(z, pg);
      await L.button(pg, 'copy address').click();
      await pg.waitForTimeout(800);
      const c2 = await clip(pg);
      await pg.close();
      const pg2 = await z.open('/receive', 'popup.html', 3500);
      const a3 = await shownAddr(pg2);
      await c.shot(pg2, 'receive');
      seen.push({ a1, q1, c1, a2, q2, c2, a3 });
      c.file('addresses.json', seen);
      const qrMatches = q1 === c1 && q2 === c2;
      const fresh = new Set([c1, c2, a3]).size === 3 && a1 === c1;
      return {
        status: qrMatches && fresh ? 'pass' : 'fail',
        note: `show -> copy -> copy -> reopen: copied #1 == QR #1: ${q1 === c1}; copied #2 == QR #2: ${q2 === c2}; copy 1, copy 2 and the reopened address all differ: ${new Set([c1, c2, a3]).size === 3} (${c.dir}/addresses.json)`,
      };
    },
  },

  r2: {
    title: 'request amount in QR and link',
    run: async c => {
      const z = await wallet(c);
      const pg = await z.open('/receive', 'popup.html', 3500);
      await z.hookCopy(pg);
      await L.clickText(pg, 'request amount');
      await pg.waitForTimeout(800);
      await pg.locator('input[inputmode=decimal]').last().fill('0.1234');
      await pg
        .locator('textarea, input[maxlength="512"]')
        .last()
        .fill('qa request')
        .catch(() => undefined);
      await c.shot(pg, 'sheet');
      const sheetQrs = await pg.locator('[role=dialog] svg[role=img]').count();
      await L.button(pg, 'copy payment link').click();
      await pg.waitForTimeout(1200);
      const link = await clip(pg);
      await pg.keyboard.press('Escape');
      await pg.waitForTimeout(1200);
      const qr = await readQr(z, pg);
      await c.shot(pg, 'after');
      const ok = /^zcash:u1[0-9a-z]+\?amount=0\.1234/.test(link) && qr === link;
      return {
        status: ok ? 'pass' : 'fail',
        note: `copied link "${link.slice(0, 20)}...${link.slice(-40)}" (amount ${/amount=0\.1234/.test(link) ? 'in it' : 'missing'}); QRs in the request sheet: ${sheetQrs}; QR on receive after copying ${qr === link ? 'equals the link' : `is "${(qr ?? 'unreadable').slice(0, 30)}..."`} (${c.dir}/sheet.png, after.png)`,
      };
    },
  },

  r3: {
    title: 'transparent on intent, one address per request, no polling',
    timeout: 300_000,
    run: async c => {
      const z = await wallet(c);
      // zcash lookups go over nym by default, where the url is out of sight; direct, for this check
      await z.sw().evaluate(async () => {
        const r = await chrome.storage.local.get('netEgress');
        const ne = r.netEgress ?? { destinations: {}, optIns: {} };
        ne.optIns = { ...ne.optIns, 'nym:zcash': 'blocked' };
        await chrome.storage.local.set({ netEgress: ne });
      });
      const TRE = /GetAddressUtxos|GetTaddress|TaddressBalance|GetAddressTxids/;
      const addrs = Object.entries(await z.storage()).filter(([k]) => /^zcashTAddrs/.test(k));
      const t0 = Date.now();
      const home = await z.open('/', 'popup.html', 20000);
      const before = z.reqs(t0).filter(r => TRE.test(r.url)).length;
      const tAsk = Date.now();
      await home.getByRole('button', { name: 'check now' }).first().click();
      await home.waitForTimeout(10000);
      const row = (L.flat(await L.text(home)).match(/transparent public.{0,40}/) ?? [''])[0];
      await c.shot(home, 'checked');
      const tIdle = Date.now();
      await L.sleep(90000);
      const all = z.reqs(t0).filter(r => TRE.test(r.url));
      const onIntent = all.filter(r => r.t >= tAsk && r.t < tIdle);
      const idle = all.filter(r => r.t >= tIdle);
      const T = /t1[1-9A-HJ-NP-Za-km-z]{33}/g;
      const perReq = onIntent.map(r => (String(r.postData ?? '').match(T) ?? []).length);
      c.file('requests.json', {
        stored: addrs.map(([k, v]) => [k, typeof v === 'object' ? Object.keys(v) : v]),
        reqs: all.map(r => ({
          dt: Math.round((r.t - t0) / 1000),
          realm: r.realm,
          url: r.url,
          addrs: String(r.postData ?? '').match(T) ?? [],
        })),
      });
      await z.sw().evaluate(async () => {
        const r = await chrome.storage.local.get('netEgress');
        delete r.netEgress.optIns['nym:zcash'];
        await chrome.storage.local.set({ netEgress: r.netEgress });
      });
      await home.close();
      const ok =
        before === 0 && onIntent.length >= 1 && idle.length === 0 && perReq.every(n => n <= 1);
      return {
        status: ok ? 'pass' : 'fail',
        note: `nym off for zcash so lookups show on the wire: t-lookups in 20s on home before asking: ${before}; after "check now": ${onIntent.length} request(s), t-addresses per request ${JSON.stringify(perReq)}; row "${row}"; next 90s idle: ${idle.length} (${c.dir}/requests.json, checked.png)`,
      };
    },
  },
};

const scannedOf = z => {
  const b = z.logs(/\[zcash-worker\] blocks \d+\.\.\d+/).pop();
  return b ? +b.text.match(/\.\.(\d+)/)[1] : 0;
};

module.exports.readQr = readQr;
module.exports.clip = clip;
module.exports.done = async () => {
  await shared?.close();
  shared = undefined;
};
