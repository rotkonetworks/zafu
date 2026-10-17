// privacy screens and network behaviour: v1-v7. v6/v7 read an egress-leak.cjs run
// (--leak <its out dir>, states default and locked, 2 runs) made on the same build.
const path = require('path'),
  fs = require('fs');
const L = require('./lib.cjs');

const fresh = async c => {
  const z = await L.launch(c.dist);
  await L.importSeed(z, L.genPhrase(24));
  return z;
};

// the egress-leak run's per-state summaries and its confirmed findings
const leak = c => {
  const dir = c.leak;
  if (!dir || !fs.existsSync(path.join(dir, 'confirmed.json'))) {
    return undefined;
  }
  const runs = fs.readdirSync(dir).filter(d => /^run\d+$/.test(d));
  const state = n =>
    runs.map(r => JSON.parse(fs.readFileSync(path.join(dir, r, `${n}.json`), 'utf8')).summary);
  return {
    dir,
    runs,
    state,
    confirmed: JSON.parse(fs.readFileSync(path.join(dir, 'confirmed.json'), 'utf8')),
  };
};
const phaseRows = (sum, phase) => ({
  cdp: Object.entries(sum.cdp).filter(([k]) => k.startsWith(phase + '|')),
  proxy: Object.entries(sum.proxy).filter(([k]) => k.startsWith(phase + '|')),
});

module.exports = {
  v1: {
    title: 'connections screen',
    run: async c => {
      const z = await fresh(c);
      try {
        const pg = await z.open('/settings/network/connections', 'popup.html', 2000);
        await c.shot(pg, 'connections');
        const t = L.flat(await L.text(pg));
        const at = s => t.indexOf(s);
        const switches = await pg
          .getByRole('switch')
          .evaluateAll(es => es.map(e => e.getAttribute('aria-label')));
        const ok =
          at('send over nym') > -1 &&
          at('send over nym') < at('in use') &&
          at('in use') < at('optional, off until you ask') &&
          switches.length > 10;
        return {
          status: ok ? 'pass' : 'fail',
          note: `order: nym rows at ${at('send over nym')}, "in use" at ${at('in use')}, "optional, off until you ask" at ${at('optional, off until you ask')}; ${switches.length} destination switches (${switches.slice(0, 6).join(', ')}, ...) (${c.dir}/connections.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  v2: {
    title: 'nym per network says what goes over nym',
    run: async c => {
      const z = await fresh(c);
      try {
        const pg = await z.open('/settings/network/connections', 'popup.html', 2000);
        await pg
          .getByRole('button', { name: /^nym, per network/ })
          .first()
          .click();
        await pg.waitForTimeout(1200);
        await c.shot(pg, 'nym-per-network');
        const t = L.flat(await L.text(pg));
        const sheet = t.slice(t.lastIndexOf('keep nym ready while unlocked'));
        const LABELS = [
          'zcash',
          'penumbra',
          'cosmos chains',
          'swaps',
          'zcash voting',
          'zcash.me',
          'buying zec',
        ];
        const rows = LABELS.map(l => {
          const i = sheet.search(new RegExp(`${l.replace('.', '\\.')} (over nym|direct) · `));
          const next = Math.min(
            ...LABELS.filter(o => o !== l)
              .map(o => sheet.indexOf(` ${o} `, i + l.length + 1))
              .filter(x => x > i),
          );
          return i < 0
            ? `${l}: (missing)`
            : `${l}: ${sheet.slice(i + l.length + 1, Number.isFinite(next) ? next : undefined).trim()}`;
        });
        const zrow = rows[0];
        const ok =
          !rows.some(r => /missing/.test(r)) &&
          /over nym · sends and your own lookups · sync direct/.test(zrow) &&
          // 29.2.0: penumbra sends over nym by default too
          /^penumbra: over nym/.test(rows[1]);
        return {
          status: ok ? 'pass' : 'fail',
          note: `rows: ${rows.join(' | ')} (${c.dir}/nym-per-network.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  v3: {
    title: 'keep nym ready on/off',
    timeout: 400_000,
    run: async c => {
      const out = {};
      for (const ready of [true, false]) {
        const z = await fresh(c);
        try {
          const pg = await z.open('/settings/network/connections', 'popup.html', 1500);
          await pg
            .getByRole('button', { name: /^nym, per network/ })
            .first()
            .click();
          await pg.waitForTimeout(800);
          out[`${ready} default`] = await pg
            .getByRole('switch', { name: 'keep nym ready while unlocked' })
            .getAttribute('aria-checked');
          await L.toggle(pg, 'keep nym ready while unlocked', ready);
          await pg.close();
          const t0 = Date.now();
          const home = await z.open('/', 'popup.html', 1000);
          await L.sleep(45000);
          const startedIdle = z.logs(/\[nym\] (starting|ready)/, t0).map(l => l.text.slice(0, 60));
          const tSend = Date.now();
          const send = await z.open('/send', 'popup.html', 1000);
          await L.sleep(30000);
          const atSend = z.logs(/\[nym\] (starting|ready)/, tSend).map(l => l.text.slice(0, 60));
          out[ready ? 'on' : 'off'] = { beforeSend: startedIdle, atSendScreen: atSend };
          await home.close();
          await send.close();
        } finally {
          await z.close();
        }
      }
      c.file('nym.json', out);
      const ok =
        out.on.beforeSend.some(s => /ready/.test(s)) &&
        !out.off.beforeSend.length &&
        out.off.atSendScreen.length > 0;
      return {
        status: ok ? 'pass' : 'fail',
        note: `default ${out['true default'] === 'true' ? 'on' : 'off'}; on: nym before any send screen ${JSON.stringify(out.on.beforeSend)}; off: before send ${JSON.stringify(out.off.beforeSend)}, at the send screen ${JSON.stringify(out.off.atSendScreen)} (${c.dir}/nym.json)`,
      };
    },
  },

  v4: {
    title: 'contacted lately',
    run: async c => {
      const z = await fresh(c);
      try {
        const home = await z.open('/', 'popup.html', 20000);
        await home.close();
        const pg = await z.open('/settings/network/contacted', 'popup.html', 2000);
        await c.shot(pg, 'contacted');
        const t = L.flat(await L.text(pg));
        const rows = [
          ...t.matchAll(
            /([a-z0-9.-]+\.[a-z]{2,}) ([^\d]{0,40}?)(\d\d:\d\d) (\d+ times? · [^·]+?)(?= [a-z0-9.-]+\.[a-z]{2,}| not contacted| nothing here)/g,
          ),
        ].map(m => `${m[1]} ${m[3]} ${m[4]}`);
        const ok = rows.length > 0 && rows.every(r => /times? · (direct|over nym|nym)/.test(r));
        return {
          status: ok ? 'pass' : 'fail',
          note: `rows: ${rows.join(' | ') || t.slice(0, 200)} (${c.dir}/contacted.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  v5: {
    title: 'block an optional destination',
    timeout: 300_000,
    run: async c => {
      const z = await fresh(c);
      try {
        const pg = await z.open('/settings/network/connections', 'popup.html', 1500);
        const sw = pg.getByRole('switch', { name: 'near intents swap', exact: true });
        const was = await sw.getAttribute('aria-checked');
        await L.toggle(pg, 'near intents swap', true);
        const blocked = !(await L.toggle(pg, 'near intents swap', false));
        await c.shot(pg, 'blocked');
        const t0 = Date.now();
        const s = await z.open('/swap', 'popup.html', 4000);
        const asked = L.flat(await L.text(s));
        await L.button(s, 'not now')
          .click({ timeout: 3000 })
          .catch(() => undefined);
        await s.getByText('select', { exact: true }).first().click();
        await s.waitForTimeout(3000);
        await s.locator('input[placeholder^="search coin"]').fill('eth ethereum');
        await s.waitForTimeout(1000);
        await s
          .getByRole('button', { name: /^eth\s*ethereum$/i })
          .first()
          .click();
        await s.waitForTimeout(800);
        await s
          .locator('input[placeholder="your address"]')
          .first()
          .fill('0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe');
        await s.waitForTimeout(8000);
        const said = L.flat(await L.text(s));
        await c.shot(s, 'swap');
        const offLine = (said.match(/near intents · .{0,70}/) ??
          said.match(/.{0,60}\b(off|turn on|turned off)\b.{0,60}/) ?? [''])[0];
        // the off line itself, or a turn-on button: one tap, and what it opens
        const tapBtn = s
          .getByRole('button', { name: /turn on|off in settings|^near intents/ })
          .or(s.getByText('near intents · off in settings'))
          .first();
        const tap = await tapBtn.count();
        let tapped = '';
        if (tap) {
          await tapBtn.click().catch(() => undefined);
          await s.waitForTimeout(1500);
          // the tap re-renders the route: read once the page answers again
          for (let i = 0; i < 8 && !tapped; i++) {
            await s.waitForTimeout(1000);
            tapped = L.flat(await L.text(s));
          }
          await c.shot(s, 'tapped');
        }
        await L.sleep(20000);
        const contacted = (await z.storage()).netContacted ?? {};
        const hits = JSON.stringify(contacted).match(/chaindefuser/g)?.length ?? 0;
        const reqs = z.reqs(t0).filter(r => /chaindefuser/.test(r.url)).length;
        c.file('evidence.json', { was, asked, said, contacted });
        const egr = JSON.stringify((await z.storage()).netEgress ?? {});
        // on again: the off line is gone, or it asks to allow, or the stored choice says so
        const turnedOn =
          (/near intents/.test(tapped) && !/near intents · off/.test(tapped)) ||
          /allow this|allow these/.test(tapped) ||
          /chaindefuser[^}]*allowed/.test(egr);
        const ok = blocked && /off/.test(offLine) && turnedOn && !hits && !reqs;
        return {
          status: ok ? 'pass' : 'fail',
          note: `near intents switch was ${was}, turned on then off: blocked ${blocked}; swap first asks only "${(asked.match(/allow th.{0,60}/) ?? [''])[0]}"; after not now + select: "${offLine}" one tap turns it on (or asks to): ${turnedOn}${tap ? ` (after the tap: "${(tapped.match(/near intents.{0,30}/) ?? [''])[0]}")` : ''}; chaindefuser requests ${reqs}, in contacted-lately ${hits} (${c.dir}/swap.png, evidence.json)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  v6: {
    title: 'nothing while locked and closed',
    run: async c => {
      const l = leak(c);
      if (!l) {
        return { status: 'block', note: 'needs --leak <egress-leak.cjs out dir> for this build' };
      }
      const per = l.state('default').map(s => phaseRows(s, 'idle-locked'));
      const n = per.map(p => p.cdp.length + p.proxy.length);
      const conf = l.confirmed.filter(f => f.code === 'IDLE-LOCKED');
      return {
        status: n.every(x => x === 0) && !conf.length ? 'pass' : 'fail',
        note: `egress-leak default state, idle-locked phase (locked, every window closed, ${process.env.IDLE_MS ?? 120000} ms) over ${l.runs.length} runs: request/connection kinds per run ${JSON.stringify(n)} ${JSON.stringify(per.map(p => [...p.cdp, ...p.proxy].map(([k, v]) => `${k} x${v}`))).slice(0, 300)}; confirmed IDLE-LOCKED findings ${conf.length} (${l.dir})`,
      };
    },
  },

  v7: {
    title: 'nothing while closed and unlocked but nym',
    run: async c => {
      const l = leak(c);
      if (!l) {
        return { status: 'block', note: 'needs --leak <egress-leak.cjs out dir> for this build' };
      }
      const per = l.state('default').map(s => phaseRows(s, 'idle-unlocked'));
      const notNym = per.map(p => [
        ...p.cdp.filter(([k]) => k.split('|')[1] !== 'nym'),
        ...p.proxy.filter(([k]) => !/:9001|nymtech\.net/.test(k)),
      ]);
      const conf = l.confirmed.filter(f => f.code === 'IDLE-UNLOCKED');
      return {
        status: notNym.every(x => !x.length) && !conf.length ? 'pass' : 'fail',
        note: `egress-leak default state, idle-unlocked phase (unlocked, every window closed): non-nym traffic per run ${JSON.stringify(notNym.map(x => x.map(([k, v]) => `${k} x${v}`))).slice(0, 400)}; nym-only rows per run ${JSON.stringify(per.map(p => p.cdp.length + p.proxy.length))}; confirmed IDLE-UNLOCKED ${conf.length} (${l.dir})`,
      };
    },
  },
};
