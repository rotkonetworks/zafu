// money paths on zcash TESTNET (run.cjs --testnet --tn <dir>): TAZ only, faucet funded.
// A (seed.txt) holds the faucet funds, B (seed-b.txt) and C (seed-c.txt) receive. Each wallet
// is a fresh profile synced from the testnet birthday; they are shared down this file, in order.
const L = require('./lib.cjs');
const T = require('./testnet.cjs');
const M = require('./money.cjs');

const W = {};
const get = async (c, k) =>
  (W[k] ??= await M.wallet(c, { A: 'seed.txt', B: 'seed-b.txt', C: 'seed-c.txt' }[k]));
const fresh = async (z, o) => (await T.addresses(z, o)).ua;
const zec = n => +n.toFixed(8);
// sync to the tip, then read the balances once
const settled = async z => {
  await T.syncToTip(z).catch(() => undefined);
  return M.balances(z);
};
const sendTxs = (z, since) => z.reqs(since).filter(r => /SendTransaction/.test(r.url));

// the memo, txid and fee a wallet's newest transaction shows, with history on
const detail = async (z, re) => {
  const pg = await z.open('/activity', 'popup.html', 3000);
  const list = L.flat(await L.text(pg));
  // a history row: a label and an amount (the tabs above it carry no amount)
  const rows = pg.locator('button, [role=button]').filter({ hasText: /\d\.\d{3,}/ });
  const row = re ? rows.filter({ hasText: re }).first() : rows.first();
  await row.click({ timeout: 5000 }).catch(() => undefined);
  await pg.waitForTimeout(2500);
  return { pg, list, text: L.flat(await L.text(pg)) };
};
// home with the one-time "keep a history?" sheet answered, so nothing covers the balances
const home = async (z, wait = 2500) => {
  const pg = await z.open('/', 'popup.html', wait);
  await L.button(pg, 'keep history')
    .click({ timeout: 1500 })
    .catch(() => undefined);
  await pg.waitForTimeout(500);
  return pg;
};
// on, only if activity says it is off: a click before the switch has loaded flips it and
// wipes what history there was
// "check now" on the transparent line, then wait while it checks (one address per request, over nym)
const checkNow = async pg => {
  await pg
    .getByRole('button', { name: 'check now' })
    .first()
    .click()
    .catch(() => undefined);
  const t0 = Date.now();
  await pg.waitForTimeout(3000);
  while (Date.now() - t0 < 150_000 && /public · checking/.test(L.flat(await L.text(pg)))) {
    await pg.waitForTimeout(3000);
  }
  return Math.round((Date.now() - t0) / 1000);
};
// zcash over nym on or off, from the nym, per network sheet (the transparent checks go direct
// while the testnet nym route is unreliable; restored after)
const nymZcash = async (z, on) => {
  const pg = await z.open('/settings/network/connections', 'popup.html', 1500);
  await pg
    .getByRole('button', { name: /^nym, per network/ })
    .first()
    .click();
  await pg.waitForTimeout(800);
  const v = await L.toggle(pg, 'zcash', on);
  await pg.close();
  return v;
};
const historyOn = async z => {
  const act = await z.open('/activity', 'popup.html', 2500);
  const off = /history stays off/.test(L.flat(await L.text(act)));
  await act.close();
  if (!off) {
    return true;
  }
  const pg = await z.open('/settings/networks/zcash', 'popup.html', 2500);
  const on = await L.toggle(pg, 'keep history on this computer', true).catch(() => false);
  await pg.close();
  return on;
};

module.exports = {
  d1: {
    title: 'shielded send, hot',
    timeout: 1_800_000,
    run: async c => {
      const [A, B] = [await get(c, 'A'), await get(c, 'B')];
      await historyOn(A);
      await historyOn(B);
      const a0 = await M.balances(A),
        b0 = await M.balances(B);
      const memo = `qa d5 memo ${Date.now().toString(36)}`;
      const r = await M.send(A, c, { to: await fresh(B), amount: '0.01', memo, tag: 'd1' });
      W.memo = memo;
      W.d1 = r;
      const b1 = await M.waitBalance(B, b => b.shielded >= zec(b0.shielded + 0.01));
      const a1 = await M.balances(A);
      // history fills in after the send: give it a few minutes
      let d;
      for (let i = 0; i < 6; i++) {
        d = await detail(A);
        if (/0\.0101|fee 0\.0001/.test(d.list + d.text)) {
          break;
        }
        await d.pg.close();
        await L.sleep(30000);
      }
      await c.shot(d.pg, 'a-detail');
      const inHistory = /0\.0101|fee 0\.0001/.test(d.list + d.text);
      const ok = r.outcome === 'complete' && r.fee === '0.0001' && b1.waited >= 0 && inHistory;
      return {
        status: ok ? 'pass' : 'fail',
        note: `A ${a0.shielded} -> B ${b0.shielded}: 0.01 TAZ with a memo, ${r.outcome} in ${r.secs}s (fee ${r.fee}, txid ${r.txid ?? (r.last.match(/[0-9a-f]{6}…[0-9a-f]{5}/) ?? [])[0]}); A now ${a1.shielded}; B saw ${b1.shielded} after ${b1.waited}s; A's history shows it (amount + ZIP-317 fee): ${inHistory} "${(d.list.match(/sent to .{0,60}/) ?? [''])[0]}" (${c.dir}/d1-review.png, d1-end.png, a-detail.png)`,
      };
    },
  },

  d5: {
    title: 'memo arrives',
    run: async c => {
      const B = await get(c, 'B');
      if (!W.memo) {
        return { status: 'block', note: 'needs d1 (it carries the memo)' };
      }
      await T.syncToTip(B);
      const d = await detail(B, /0\.01/);
      await c.shot(d.pg, 'b-detail');
      const inbox = L.flat(await L.text(await B.open('/inbox', 'popup.html', 3000)));
      const seen = d.text.includes(W.memo) || inbox.includes(W.memo);
      return {
        status: seen ? 'pass' : 'fail',
        note: `memo "${W.memo}" in B's transaction detail: ${d.text.includes(W.memo)}, in B's people tab: ${inbox.includes(W.memo)} (${c.dir}/b-detail.png)`,
      };
    },
  },

  d2: {
    title: 'send over nym, contacted lately counts it',
    run: async c => {
      const A = await get(c, 'A');
      if (!W.d1) {
        return { status: 'block', note: 'needs d1' };
      }
      const direct = sendTxs(A, W.d1.t0);
      const nym = A.logs(/\[nym\] (ready|starting)/).map(l => l.text.slice(0, 40));
      const pg = await A.open('/settings/network/contacted', 'popup.html', 2000);
      await c.shot(pg, 'contacted');
      const t = L.flat(await L.text(pg));
      const row = (t.match(/tzcash\.rotko\.net.{0,120}/) ?? [''])[0];
      const ok = W.d1.outcome === 'complete' && !direct.length && /nym/.test(row);
      return {
        status: ok ? 'pass' : 'fail',
        note: `d1's send went out with ${direct.length} direct SendTransaction on the wire, nym ${JSON.stringify(nym)}; send screen said "${(W.d1.last.match(/(still sending over nym|over nym)[^·]{0,40}/) ?? ['(no nym note)'])[0]}"; contacted lately: "${row}" (${c.dir}/contacted.png)`,
      };
    },
  },

  d6: {
    title: 'transaction detail and the explorer setting',
    run: async c => {
      const A = await get(c, 'A');
      await historyOn(A);
      // history is rebuilt after it is turned on: wait for the first row
      for (let i = 0; i < 10; i++) {
        const act = await A.open('/activity', 'popup.html', 3000);
        const has = /\d\.\d{3,}/.test(L.flat(await L.text(act)));
        await act.close();
        if (has) {
          break;
        }
        await L.sleep(30000);
      }
      const out = {};
      for (const mode of ['off', 'copy', 'open']) {
        const st = await A.open('/settings/networks/zcash', 'popup.html', 1500);
        await st
          .getByRole('button', { name: /^explorer links/ })
          .first()
          .click();
        await st.waitForTimeout(600);
        await st
          .getByRole('button', { name: new RegExp(`^${mode}\\b`) })
          .last()
          .click();
        await st.waitForTimeout(600);
        await st.close();
        const d = await detail(A);
        const link = (d.text.match(/https:\/\/\S+\/tx\/[0-9a-f]+/) ?? [])[0];
        const t0 = Date.now();
        let opened;
        if (mode === 'open' && link) {
          const before = A.ctx.pages().length;
          await d.pg
            .getByText(link)
            .first()
            .click()
            .catch(() => undefined);
          await d.pg.waitForTimeout(2500);
          opened = A.ctx.pages().length > before ? A.ctx.pages().at(-1).url() : undefined;
        }
        await c.shot(d.pg, `detail-${mode}`);
        out[mode] = {
          link,
          opened,
          txid: (d.text.match(/\b[0-9a-f]{64}\b/) ?? [])[0],
          fee: /fee/.test(d.text),
          at: Date.now() - t0,
        };
        await d.pg.close();
      }
      c.file('explorer.json', out);
      const ok =
        !out.off.link && !!out.copy.link && !!out.open.link && !!out.open.opened && out.off.fee;
      return {
        status: ok ? 'pass' : 'fail',
        note: `newest tx detail shows fee ${out.off.fee}; explorer off: no link ${!out.off.link}; copy: "${out.copy.link ?? 'none'}"; open: opened ${out.open.opened ?? 'nothing'} (the testnet build still links zecblock.com, a mainnet explorer) (${c.dir}/explorer.json, detail-*.png)`,
      };
    },
  },

  d3: {
    title: "nym unreachable: asks first, 'don't send' sends nothing",
    timeout: 1_200_000,
    run: async c => {
      const A = await get(c, 'A');
      const B = await get(c, 'B');
      const a0 = await M.balances(A);
      A.proxy.setCut(M.NYM_CUT);
      A.proxy.drop();
      const t0 = Date.now();
      const r = await M.send(A, c, {
        to: await fresh(B),
        amount: '0.001',
        tag: 'd3',
        onHeld: "don't send",
        ms: 4 * 60_000,
      });
      A.proxy.setCut(() => false);
      await L.sleep(120000);
      const a1 = await settled(A);
      const direct = sendTxs(A, t0);
      const ok =
        !!r.held && r.outcome === 'declined' && !direct.length && a1.shielded === a0.shielded;
      return {
        status: ok ? 'pass' : 'fail',
        note: `nym cut at the proxy (port 9001 and nymtech.net): send ${r.outcome}; it asked "${r.held.slice(0, 140)}"; after "don't send": direct SendTransaction ${direct.length}, balance ${a0.shielded} -> ${a1.shielded} two minutes later (${c.dir}/d3-held.png, d3-end.png)`,
      };
    },
  },

  d4: {
    title: 'stop while building: nothing broadcast',
    timeout: 1_200_000,
    run: async c => {
      const A = await get(c, 'A');
      const B = await get(c, 'B');
      const a0 = await M.balances(A);
      const t0 = Date.now();
      const r = await M.send(A, c, {
        to: await fresh(B),
        amount: '0.001',
        tag: 'd4',
        stopFast: true,
        ms: 3 * 60_000,
      });
      await L.sleep(120000);
      const a1 = await settled(A);
      const nymOut = A.logs(/broadcast|SendTransaction/i, t0).map(l => l.text.slice(0, 80));
      const ok =
        r.outcome === 'stopped' &&
        /stop pressed as offered: true/.test(r.stopped) &&
        !/sent \d/.test(r.last) &&
        a1.shielded === a0.shielded;
      return {
        status: ok ? 'pass' : 'fail',
        note: `network slowed (1.5 s latency) so the build lasts long enough to stop; "stop this send" pressed as soon as offered (click reported ${r.stopHit ? 'ok' : 'an error after the press'}); back on review with the form kept: ${backToReview}; right after: "${(r.stopShot ?? '').slice(-140)}"; 30s later: "${(r.last.match(/(proving|broadcasting|sent|stopped|still sending).{0,90}/) ?? [r.last.slice(0, 80)])[0]}"; SendTransaction on the wire ${sendTxs(A, t0).length}; broadcast lines ${JSON.stringify(nymOut).slice(0, 120)}; balance ${a0.shielded} -> ${a1.shielded} two minutes later (${c.dir}/d4-before-stop.png, d4-end.png)`,
      };
    },
  },

  't-taddr-receive': {
    title: 't-address receive (z->t to own transparent, found on "check now")',
    timeout: 1_800_000,
    run: async c => {
      const A = await get(c, 'A');
      await nymZcash(A, false);
      const { tm } = await T.addresses(A, { transparent: true });
      const r = await M.send(A, c, { to: tm, amount: '0.005', tag: 'z2t' });
      W.z2t = r;
      let t = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60_000) {
        await T.syncToTip(A).catch(() => undefined);
        const hp = await home(A);
        W.checkSecs = await checkNow(hp);
        t = L.flat(await L.text(hp));
        await c.shot(hp, 'home');
        await hp.close();
        if (/transparent public.{0,40}0\.005/.test(t) || /\bshield\b/.test(t)) {
          break;
        }
        await L.sleep(30000);
      }
      const got = /0\.0050/.test(t) || /\bshield\b/.test(t);
      return {
        status: r.outcome === 'complete' && got ? 'pass' : 'fail',
        note: `0.005 TAZ to own ${tm?.slice(0, 8)}...: send ${r.outcome} (fee ${r.fee}, review "${(r.rev.match(/transparent[^·]{0,40}/) ?? [''])[0]}"); home after "check now" (last check took ${W.checkSecs}s): "${(t.match(/transparent public.{0,40}/) ?? [''])[0]}" in ${Math.round((Date.now() - t0) / 1000)}s (${c.dir}/home.png)`,
      };
    },
  },

  d7: {
    title: 'shield transparent funds',
    timeout: 1_800_000,
    run: async c => {
      const A = await get(c, 'A');
      await nymZcash(A, false);
      const a0 = await M.balances(A);
      const hp = await home(A);
      W.checkSecs = await checkNow(hp);
      const sh = L.button(hp, 'shield');
      if (!(await sh.isVisible().catch(() => false))) {
        return {
          status: 'block',
          note: `no transparent balance to shield (needs t-taddr-receive): "${(L.flat(await L.text(hp)).match(/transparent public.{0,40}/) ?? [''])[0]}"`,
        };
      }
      await sh.click();
      await hp.waitForTimeout(4000);
      const sheet = L.flat(await L.text(hp));
      await c.shot(hp, 'shield-sheet');
      await hp
        .locator('[role=dialog] button')
        .filter({ hasText: /^shield$/ })
        .last()
        .click()
        .catch(() => L.button(hp, 'shield').last().click());
      await z_unlock(A, hp);
      let t = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 5 * 60_000) {
        await hp.waitForTimeout(3000);
        t = L.flat(await L.text(hp));
        if (/pending|shielded|sent|transaction id|done/.test(t) && !/building|proving/.test(t)) {
          break;
        }
      }
      await c.shot(hp, 'shield-end');
      const a1 = await M.waitBalance(
        A,
        b => b.shielded > a0.shielded && !(b.transparent > 0),
        20 * 60_000,
      );
      return {
        status: a1.waited >= 0 ? 'pass' : 'fail',
        note: `shield sheet "${sheet.slice(sheet.lastIndexOf('shield'), sheet.lastIndexOf('shield') + 100)}"; after: "${t.slice(0, 100)}"; balances shielded ${a0.shielded} -> ${a1.shielded}, transparent ${a0.transparent} -> ${a1.transparent} (waited ${a1.waited}s) (${c.dir}/shield-sheet.png, shield-end.png)`,
      };
    },
  },

  p1: {
    title: 'new pocket: named, in the header, own address',
    run: async c => {
      const A = await get(c, 'A');
      const pg = await home(A, 2000);
      await pg.getByRole('button', { name: 'accounts' }).click();
      await pg.waitForTimeout(800);
      await pg
        .getByRole('button', { name: /new pocket/ })
        .first()
        .click();
      await pg.waitForTimeout(600);
      await pg.locator('[role=dialog] input').last().fill('qa pocket');
      await L.button(pg, 'create pocket').click();
      await pg.waitForTimeout(2500);
      const head = L.flat(await L.text(pg)).slice(0, 80);
      await c.shot(pg, 'header');
      const pocketAddr = await fresh(A);
      W.pocketAddr = pocketAddr;
      const ok = /qa pocket/.test(head);
      return {
        status: ok ? 'pass' : 'fail',
        note: `after "create pocket": header "${head}"; the pocket's receive address ${pocketAddr?.slice(0, 14)}... (${c.dir}/header.png)`,
      };
    },
  },

  p2: {
    title: 'receive into a pocket, send from it: only its notes',
    timeout: 2_400_000,
    run: async c => {
      const A = await get(c, 'A');
      const B = await get(c, 'B');
      const pick = async name => {
        const pg = await home(A, 2000);
        await pg.getByRole('button', { name: 'accounts' }).click();
        await pg.waitForTimeout(800);
        await pg
          .locator('[role=dialog] [role=button], [role=dialog] button')
          .filter({ hasText: name })
          .first()
          .click();
        await pg.waitForTimeout(2000);
        await pg.close();
      };
      await pick('qa pocket');
      const pocketTo = await fresh(A);
      await pick(/^main|wallet 1/);
      const main0 = await M.balances(A);
      const r1 = await M.send(A, c, { to: pocketTo, amount: '0.006', tag: 'to-pocket' });
      await pick('qa pocket');
      const p1 = await M.waitBalance(A, b => b.shielded >= 0.006);
      await pick(/^main|wallet 1/);
      const main1 = await M.balances(A);
      await pick('qa pocket');
      const r2 = await M.send(A, c, { to: await fresh(B), amount: '0.002', tag: 'from-pocket' });
      const p2 = await M.waitBalance(A, b => b.shielded <= zec(p1.shielded - 0.002), 15 * 60_000);
      await pick(/^main|wallet 1/);
      const main2 = await M.balances(A);
      const ok =
        r1.outcome === 'complete' &&
        r2.outcome === 'complete' &&
        p1.shielded >= 0.006 &&
        main2.shielded === main1.shielded;
      return {
        status: ok ? 'pass' : 'fail',
        note: `main ${main0.shielded} -> pocket 0.006 (${r1.outcome}); pocket saw ${p1.shielded}; pocket -> B 0.002 (${r2.outcome}, fee ${r2.fee}); pocket ${p1.shielded} -> ${p2.shielded}; main before/after the pocket spend ${main1.shielded} / ${main2.shielded} (${c.dir}/from-pocket-review.png)`,
      };
    },
  },

  p3: {
    title: 'hide a pocket, show it again, funds kept',
    run: async c => {
      const A = await get(c, 'A');
      const accounts = async () => {
        const pg = await home(A, 2000);
        await pg.getByRole('button', { name: 'accounts' }).click();
        await pg.waitForTimeout(1000);
        return pg;
      };
      let pg = await accounts();
      const before = L.flat(await L.text(pg));
      await pg.getByRole('button', { name: 'rename qa pocket' }).first().click();
      await pg.waitForTimeout(800);
      const holds = L.flat(await L.text(pg)).match(
        /it still holds [\d.]+ zec[^·]*· it stays yours/,
      )?.[0];
      await L.button(pg, 'hide this pocket').click();
      await pg.waitForTimeout(2000);
      await pg.close();
      pg = await accounts();
      const hiddenList = L.flat(await L.text(pg));
      await c.shot(pg, 'hidden');
      const hidden =
        /hidden · 1/.test(hiddenList) &&
        !/qa pocket/.test(hiddenList.slice(hiddenList.indexOf('accounts')));
      await pg
        .getByRole('button', { name: /hidden · 1/ })
        .first()
        .click();
      await pg.waitForTimeout(1200);
      const hiddenScreen = L.flat(await L.text(pg));
      c.file('hidden-screen.txt', hiddenScreen);
      await c.shot(pg, 'hidden-pockets');
      await pg
        .getByRole('button', { name: /^(show|unhide|bring back)/ })
        .first()
        .click()
        .catch(async () => {
          await pg.getByText('qa pocket').first().click();
          await pg.waitForTimeout(800);
          await pg
            .getByRole('button', { name: /^(show|unhide|bring back)/ })
            .first()
            .click();
        });
      await pg.waitForTimeout(1500);
      await pg.close();
      pg = await accounts();
      const back = L.flat(await L.text(pg));
      await c.shot(pg, 'shown');
      const kept = (back.match(/qa pocket\D{0,20}([\d.]+)/) ?? [])[1];
      return {
        status: /qa pocket/.test(before) && hidden && /qa pocket/.test(back) ? 'pass' : 'fail',
        note: `hide said "${holds ?? '(no holds line)'}"; after hiding the list shows "hidden · 1" and not the pocket: ${hidden}; hidden list "${hiddenScreen.slice(-120)}"; after showing it is back: ${/qa pocket/.test(back)}${kept ? ` (${kept})` : ''} (${c.dir}/hidden.png, hidden-pockets.png, shown.png)`,
      };
    },
  },

  't-tsend': {
    title: "send to someone else's transparent address (public), review says so",
    timeout: 1_800_000,
    run: async c => {
      const A = await get(c, 'A');
      const B = await get(c, 'B');
      await nymZcash(B, false);
      const { tm } = await T.addresses(B, { transparent: true });
      const r = await M.send(A, c, { to: tm, amount: '0.002', tag: 'z2t-b' });
      const said = (r.rev.match(/(transparent|public)[^·]{0,60}/) ?? [''])[0];
      let t = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60_000) {
        await T.syncToTip(B).catch(() => undefined);
        const hp = await home(B, 2000);
        W.checkSecs = await checkNow(hp);
        t = L.flat(await L.text(hp));
        await hp.close();
        if (/transparent public.{0,30}0\.002/.test(t)) {
          break;
        }
        await L.sleep(30000);
      }
      const got = /transparent public.{0,30}0\.002/.test(t);
      return {
        status:
          r.outcome === 'complete' && /transparent|public/.test(said) && got ? 'pass' : 'fail',
        note: `A -> B's ${tm?.slice(0, 6)}... 0.002: ${r.outcome} (fee ${r.fee}); review said "${said}"; B's "check now" shows "${(t.match(/transparent public.{0,30}/) ?? [''])[0]}" (spending a transparent balance is shield-first by design: send offers only the shielded balance) (${c.dir}/z2t-b-review.png)`,
      };
    },
  },

  't-memo-edge': {
    title: 'memo edges: 512 bytes, 513 refused calmly, non-ascii intact',
    timeout: 2_400_000,
    run: async c => {
      const A = await get(c, 'A');
      const C = await get(c, 'C');
      await historyOn(C);
      const tag = Date.now().toString(36);
      const m512 = `qa512 ${tag} `.padEnd(512, 'x');
      const m513 = m512 + 'y';
      const uni = `qa 匿 名 ${tag} · ünï`;
      // 513 bytes: the form should hold it back, calmly
      const pg = await A.open('/send', 'popup.html', 2000);
      await A.unlock(pg);
      await pg.locator('input[placeholder="address or contact"]').fill(await fresh(C));
      await pg.locator('input[inputmode=decimal]').first().fill('0.001');
      const box = pg.locator('textarea:visible, input[placeholder^="optional"]:visible').first();
      await box.fill(m513);
      await pg.waitForTimeout(800);
      const kept = (await box.inputValue()).length;
      const t513 = L.flat(await L.text(pg));
      const reviewOk = await L.button(pg, 'review').isEnabled();
      await c.shot(pg, 'memo-513');
      await pg.close();
      const r1 = await M.send(A, c, {
        to: await fresh(C),
        amount: '0.001',
        memo: m512,
        tag: 'memo-512',
      });
      const r2 = await M.send(A, c, {
        to: await fresh(C),
        amount: '0.001',
        memo: uni,
        tag: 'memo-uni',
      });
      await M.waitBalance(C, b => b.shielded >= 0.002);
      const list = L.flat(await L.text(await C.open('/activity', 'popup.html', 3000)));
      const d1 = await detail(C, /0\.001/);
      const all =
        d1.text +
        ' ' +
        list +
        ' ' +
        L.flat(await L.text(await C.open('/inbox', 'popup.html', 3000)));
      const got512 = all.includes(m512.slice(0, 60));
      const gotUni = all.includes(uni);
      const calm513 = kept <= 512 || !reviewOk;
      return {
        status:
          calm513 && r1.outcome === 'complete' && r2.outcome === 'complete' && got512 && gotUni
            ? 'pass'
            : 'fail',
        note: `513-byte memo: field kept ${kept} chars, review enabled ${reviewOk}, said "${(t513.match(/memo.{0,60}/) ?? [''])[0]}"; 512-byte send ${r1.outcome}, seen by C: ${got512}; "${uni}" send ${r2.outcome}, seen intact: ${gotUni} (${c.dir}/memo-513.png)`,
      };
    },
  },

  't-max': {
    title: 'send max empties the wallet, fee right',
    timeout: 2_400_000,
    run: async c => {
      const A = await get(c, 'A');
      const C = await get(c, 'C');
      const c0 = await settled(C);
      if (!(c0.shielded > 0.0002)) {
        return { status: 'block', note: `C holds ${c0.shielded}; needs t-memo-edge to fund it` };
      }
      const r = await M.send(C, c, { to: await fresh(A), max: true, tag: 'max' });
      const sent = +((r.rev.match(/you send ([\d.]+) zec/) ?? [])[1] ?? 0);
      const c1 = await M.waitBalance(C, b => b.shielded === 0, 20 * 60_000);
      return {
        status:
          r.outcome === 'complete' && c1.shielded === 0 && zec(sent + +r.fee) === c0.shielded
            ? 'pass'
            : 'fail',
        note: `C held ${c0.shielded}; max sends ${sent} + fee ${r.fee} = ${zec(sent + +r.fee)}; ${r.outcome}; C after ${c1.shielded} (waited ${c1.waited}s) (${c.dir}/max-review.png)`,
      };
    },
  },

  't-dust': {
    title: 'change below dust: handled without a broken send',
    timeout: 2_400_000,
    run: async c => {
      const A = await get(c, 'B');
      const b0 = await settled(A);
      if (!(b0.shielded > 0.0003)) {
        return { status: 'block', note: `B holds ${b0.shielded}` };
      }
      // leave 1000 zat of change after the 0.0001 fee
      const amount = zec(b0.shielded - 0.0001 - 0.00001).toFixed(8);
      const r = await M.send(A, c, { to: await fresh(await get(c, 'A')), amount, tag: 'dust' });
      const b1 = await M.waitBalance(A, b => b.shielded < b0.shielded, 20 * 60_000);
      return {
        status:
          ['complete', 'review-disabled'].includes(r.outcome) &&
          (r.outcome !== 'complete' || b1.waited >= 0)
            ? 'pass'
            : 'fail',
        note: `B ${b0.shielded}: send ${amount} leaving 0.00001 change: ${r.outcome}; review "${(r.rev ?? r.form ?? '').slice(0, 140)}"; B after ${b1.shielded} (${c.dir}/dust-review.png)`,
      };
    },
  },

  't-exact': {
    title: 'send the exact balance (amount + fee = balance)',
    timeout: 2_400_000,
    run: async c => {
      const B = await get(c, 'B');
      const b0 = await settled(B);
      if (!(b0.shielded > 0.0002)) {
        return { status: 'block', note: `B holds ${b0.shielded}` };
      }
      const amount = zec(b0.shielded - 0.0001).toFixed(8);
      const r = await M.send(B, c, { to: await fresh(await get(c, 'A')), amount, tag: 'exact' });
      const b1 = await M.waitBalance(B, b => b.shielded === 0, 20 * 60_000);
      return {
        status: r.outcome === 'complete' && b1.shielded === 0 ? 'pass' : 'fail',
        note: `B ${b0.shielded}: typed ${amount} (fee ${r.fee}): ${r.outcome}; B after ${b1.shielded} (waited ${b1.waited}s); this is also the B -> A direction (${c.dir}/exact-review.png)`,
      };
    },
  },

  't-pools': {
    title: 'which pools the notes sit in (ironwood / orchard)',
    run: async c => {
      const A = await get(c, 'A');
      const pg = await A.open('/pool-notes', 'popup.html', 3000);
      const t = L.flat(await L.text(pg));
      await c.shot(pg, 'pools');
      return {
        status: /ironwood/.test(t) ? 'pass' : 'fail',
        note: `A's pool notes: "${t.slice(t.indexOf('pool'), t.indexOf('pool') + 200)}"; every send above spent and paid ironwood (testnet faucet funds arrive post-NU6.3) (${c.dir}/pools.png)`,
      };
    },
  },

  't-nym-restart': {
    title: 'after a browser restart, a send over nym still goes (it does not)',
    timeout: 900_000,
    run: async c => {
      // the long-lived profile from setup, relaunched: the same thing a person's browser does
      const path = require('path');
      const z = await L.launch(c.dist, {
        profile: path.join(c.tn, 'profA'),
        password: T.secret(c.tn, 'password.txt'),
      });
      try {
        await T.syncToTip(z, 8 * 60_000);
        const B = await get(c, 'B');
        const a0 = await M.balances(z);
        const r = await M.send(z, c, {
          to: await fresh(B),
          amount: '0.001',
          tag: 'restart',
          onHeld: "don't send",
          ms: 4 * 60_000,
        });
        const nym = z.logs(/\[nym\]/).map(l => l.text.slice(0, 50));
        await L.sleep(60000);
        const a1 = await settled(z);
        return {
          status: r.outcome === 'complete' ? 'pass' : 'fail',
          note: `relaunched profile (prod build shows the same: first launch nym probe 200, after a restart "nym isn't reachable right now"): send ${r.outcome}${r.held ? `, held: "${r.held.slice(0, 90)}" -> don't send` : ''}; nym lines ${JSON.stringify(nym)}; balance ${a0.shielded} -> ${a1.shielded} (${c.dir}/restart-held.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  h5: {
    title: 'shared wallet 2 of 3 over the live relay, a payment signed by two',
    timeout: 3_600_000,
    run: async c => {
      const [A, B, C] = [await get(c, 'A'), await get(c, 'B'), await get(c, 'C')];
      const CODE = /\b\d{3,4}-[a-z]+-[a-z]+\b/;
      const waitT = async (pg, re, ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const t = L.flat(await L.text(pg));
          if (re.test(t)) {
            return t;
          }
          await pg.waitForTimeout(1500);
        }
        return null;
      };
      const dump = async (pg, n) => {
        await c.shot(pg, n);
        const t = L.flat(await L.text(pg));
        c.file(`${n}.txt`, t);
        return t;
      };
      const join = async (Z, code, nick) => {
        const j = await Z.open('/inbox/join', 'popup.html', 2000);
        const ji = j.locator('input:visible');
        await ji.first().fill(code);
        if ((await ji.count()) > 1) {
          await ji.nth(1).fill(nick);
        }
        await L.button(j, 'join').click();
        await j.waitForTimeout(2500);
        await L.button(j, 'allow')
          .click({ timeout: 3000 })
          .catch(() => undefined);
        return j;
      };
      const name = `qa sw ${Date.now().toString(36).slice(-4)}`;
      const g = await A.open('/inbox/new-group', 'popup.html', 2000);
      const gi = g.locator('input:visible');
      await gi.first().fill(name);
      if ((await gi.count()) > 1) {
        await gi.nth(1).fill('alice');
      }
      await L.button(g, 'invite and create').click();
      await g.waitForTimeout(2500);
      await L.button(g, 'allow')
        .click({ timeout: 3000 })
        .catch(() => undefined);
      const code1 = ((await waitT(g, CODE, 30000)) ?? '').match(CODE)?.[0];
      const jb = await join(B, code1, 'bob');
      await waitT(jb, new RegExp(name), 60000);
      await L.button(g, 'invite another').click();
      await g.waitForTimeout(3000);
      const code2 = (L.flat(await L.text(g)).match(new RegExp(CODE.source, 'g')) ?? []).find(
        x => x !== code1,
      );
      const jc = await join(C, code2, 'carol');
      await waitT(jc, new RegExp(name), 60000);
      await L.button(g, 'open the group')
        .click()
        .catch(() => undefined);
      await waitT(g, /3 people/, 60000);
      await g.getByRole('button', { name: 'make it a shared wallet' }).click();
      await g.waitForTimeout(1200);
      const sheet = await dump(g, 'a-sheet');
      await L.button(g, 'make keys together').click();
      for (const p of [jb, jc]) {
        await waitT(p, /agree and make keys/, 60000);
        await L.button(p, 'agree and make keys').click();
      }
      const ready = await waitT(g, /shared wallet · ready/, 300_000);
      await dump(g, 'a-ready');
      if (!ready) {
        return {
          status: 'fail',
          note: `keys never reached ready: "${L.flat(await L.text(g)).slice(0, 200)}" (${c.dir}/a-ready.png)`,
        };
      }
      // fund it from A's own wallet: "add funds"
      await A.hookCopy(g);
      await L.button(g, 'copy address').click();
      await g.waitForTimeout(800);
      const msAddr = await A.copied(g);
      const vaults = (await A.storage()).vaults.map(v => `${v.name}:${v.type}`);
      // A's hot wallet is the active one for the funding send
      const fund = await M.send(A, c, { to: msAddr, amount: '0.01', tag: 'fund' });
      let shared = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 25 * 60_000) {
        await T.syncToTip(A).catch(() => undefined);
        await g.reload();
        await g.waitForTimeout(4000);
        shared = (L.flat(await L.text(g)).match(/2 of 3 · [\d.]+ zec shared/) ?? [''])[0];
        if (/0\.01/.test(shared)) {
          break;
        }
        await L.sleep(30000);
      }
      await dump(g, 'a-funded');
      // the payment: A starts it from the shared wallet, B adds the second seal
      await L.button(g, 'send from it').click();
      await g.waitForTimeout(2500);
      const to = await fresh(B);
      const pay = await M.send(A, c, {
        to,
        amount: '0.004',
        tag: 'ms-pay',
        page: g,
        ms: 2 * 60_000,
      }).catch(e => ({ outcome: 'threw ' + e.message.split('\n')[0], last: '' }));
      await dump(pay.pg ?? g, 'a-pay');
      const room = await B.open('/inbox', 'popup.html', 2500);
      await room
        .getByText(name, { exact: true })
        .first()
        .click()
        .catch(() => undefined);
      const ask = await waitT(room, /sign|seal|approve|agree/, 120000);
      await dump(room, 'b-ask');
      await room
        .getByRole('button', { name: /^(sign|add my seal|approve|agree)/ })
        .first()
        .click()
        .catch(() => undefined);
      const done = await waitT(pay.pg ?? g, /sent|view transaction|broadcast/, 300_000);
      await dump(pay.pg ?? g, 'a-pay-end');
      return {
        status: ready && /0\.01/.test(shared) && !!done ? 'pass' : 'fail',
        note: `group "${name}" with door codes ${code1}, ${code2}; sheet "${sheet.slice(sheet.indexOf('make it a shared wallet'), sheet.indexOf('make it a shared wallet') + 110)}"; keys ready over relay.zafu.pro: ${!!ready}; vaults ${JSON.stringify(vaults)}; funded 0.01 (${fund.outcome}) -> "${shared}"; payment 0.004 to B: ${pay.outcome}, B was asked: ${!!ask}, ended "${(done ?? '').slice(0, 80)}" (${c.dir}/a-ready.png, a-pay.png, b-ask.png, a-pay-end.png)`,
      };
    },
  },
};

// the password, if a send or shield asks for it again
const z_unlock = async (z, pg) => {
  await pg.waitForTimeout(800);
  await z.unlock(pg);
};

module.exports.done = async () => {
  for (const k of Object.keys(W)) {
    if (W[k]?.close) {
      await W[k].close();
    }
    delete W[k];
  }
};
