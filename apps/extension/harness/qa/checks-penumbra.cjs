// penumbra on/off and its nym row: n1 n3 (no penumbra funds are touched)
const L = require('./lib.cjs');

const PEN = /penumbra\.rotko\.net/;
const setPenumbra = async (z, on) => {
  const pg = await z.open('/settings/devices', 'popup.html', 1500);
  await pg
    .getByRole('button', { name: /^networks/ })
    .first()
    .click();
  await pg.waitForTimeout(800);
  const sw = pg.getByRole('switch', { name: 'Penumbra', exact: true });
  if ((await sw.getAttribute('aria-checked')) !== String(on)) {
    await sw.click();
    await pg.waitForTimeout(1200);
    // turning it on asks where its sync starts
    await L.button(pg, 'turn on')
      .click({ timeout: 3000 })
      .catch(() => undefined);
    await pg.waitForTimeout(2000);
  }
  await pg.close();
  return ((await z.storage()).enabledNetworks ?? []).includes('penumbra');
};
const penHits = (z, since) => [
  ...z
    .reqs(since)
    .filter(r => PEN.test(r.url))
    .map(r => `${r.realm} ${r.url.slice(0, 90)}`),
  ...z.proxy.log
    .filter(x => x.t >= since && PEN.test(x.host))
    .map(x => `proxy ${x.kind} ${x.host}:${x.port}`),
];

module.exports = {
  n1: {
    title: 'penumbra on syncs, off is never contacted',
    timeout: 400_000,
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const t0 = Date.now();
        const before = penHits(z, 0);
        const on = await setPenumbra(z, true);
        const home = await z.open('/', 'popup.html', 1000);
        await L.sleep(45000);
        const whileOn = penHits(z, t0);
        await c.shot(home, 'on');
        const onText = L.flat(await L.text(home));
        const off = !(await setPenumbra(z, false));
        const t1 = Date.now() + 3000;
        await home.reload();
        for (const r of ['/', '/receive', '/settings', '/inbox']) {
          const pg = await z.open(r, 'popup.html', 8000);
          await pg.close();
        }
        await L.sleep(60000);
        const whileOff = penHits(z, t1);
        c.file('requests.json', { before, whileOn, whileOff });
        const ok = !before.length && on && whileOn.length > 0 && off && !whileOff.length;
        return {
          status: ok ? 'pass' : 'fail',
          note: `zcash-only wallet: penumbra.rotko.net contacts before ${before.length}; Penumbra switch on: ${whileOn.length} in 45s, home "${onText.slice(0, 60)}"; switch off, then 90s across home/receive/settings/people: ${whileOff.length} (${c.dir}/requests.json)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  n3: {
    title: 'penumbra sends over nym by default (29.2.0); turning it off says direct',
    timeout: 300_000,
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        await setPenumbra(z, true);
        const pg = await z.open('/settings/network/connections', 'popup.html', 1500);
        await pg
          .getByRole('button', { name: /^nym, per network/ })
          .first()
          .click();
        await pg.waitForTimeout(800);
        const t = L.flat(await L.text(pg));
        const row0 = (t
          .slice(t.lastIndexOf('keep nym ready'))
          .match(/penumbra (direct|over nym) · [^·]+/) ?? [''])[0];
        const def = await pg
          .getByRole('switch', { name: 'penumbra', exact: true })
          .getAttribute('aria-checked');
        // the default's broadcast first, then off
        const tP = Date.now();
        const probe = await z.open('/', 'popup.html', 1500);
        const res = await probe.evaluate(() =>
          Promise.race([
            fetch(
              'https://penumbra.rotko.net/penumbra.util.tendermint_proxy.v1.TendermintProxyService/BroadcastTxSync',
              {
                method: 'POST',
                headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
                body: new Uint8Array(5),
              },
            ).then(
              r => r.status,
              e => String(e.message),
            ),
            new Promise(r => setTimeout(() => r('pending'), 90000)),
          ]),
        );
        const direct = z.reqs(tP).filter(r => /BroadcastTxSync/.test(r.url) && r.realm !== 'nym');
        const nymUp = z.logs(/\[nym\] (starting|ready)/, tP).map(l => l.text.slice(0, 50));
        await L.toggle(pg, 'penumbra', false);
        const t2 = L.flat(await L.text(pg));
        const row1 = (t2
          .slice(t2.lastIndexOf('keep nym ready'))
          .match(/penumbra (direct|over nym) · [^·]+/) ?? [''])[0];
        await c.shot(pg, 'nym-off');
        const ok =
          def === 'true' &&
          /^penumbra over nym/.test(row0) &&
          /^penumbra direct/.test(row1) &&
          !direct.length;
        return {
          status: ok ? 'pass' : 'fail',
          note: `default "${row0}" (switch ${def}); turned off: "${row1}"; by default an empty BroadcastTxSync from the popup answered ${JSON.stringify(res)}, direct on the wire: ${direct.length}, nym ${JSON.stringify(nymUp)} (${c.dir}/nym-off.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },
};
