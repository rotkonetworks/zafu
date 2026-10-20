// people: h1-h4 h6, over the live relay (relay.zafu.pro), two fresh profiles
const L = require('./lib.cjs');

const dump = async (c, pg, n) => {
  await c.shot(pg, n);
  const t = L.flat(await L.text(pg));
  c.file(n + '.txt', t);
  return t;
};
const waitText = async (pg, re, ms = 60000) => {
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

// A's card links: the zafu: one, then the web one (allowing the relay when asked)
const cardLinks = async z => {
  const a = await z.open('/inbox/add', 'popup.html', 2500);
  await z.hookCopy(a);
  const order = (await a.getByRole('button', { name: /^for (zafu|anyone)/ }).allInnerTexts()).map(
    s => s.split('\n')[0],
  );
  await a.getByRole('button', { name: /^for zafu/ }).click();
  await a.waitForTimeout(1000);
  await L.button(a, 'allow')
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await a.waitForTimeout(3000);
  let zafu = await z.copied(a);
  if (!zafu) {
    await a.getByRole('button', { name: /^for zafu/ }).click();
    await a.waitForTimeout(3000);
    zafu = await z.copied(a);
  }
  await a.getByRole('button', { name: /^for anyone/ }).click();
  await a.waitForTimeout(2500);
  const web = await z.copied(a);
  return { a, zafu, web, order };
};

// two profiles that hold each other as people, with a direct thread open on each side
let pair;
const paired = async c => {
  if (pair) {
    return pair;
  }
  const A = await L.launch(c.dist),
    B = await L.launch(process.env.QA_DIST_B ?? c.dist);
  await Promise.all([L.importSeed(A, L.genPhrase(24)), L.importSeed(B, L.genPhrase(24))]);
  const { a, zafu } = await cardLinks(A);
  const b = await B.open('/inbox/scan', 'popup.html', 2500);
  await b.locator('input:visible').first().fill(zafu);
  await b.keyboard.press('Enter');
  await b.waitForTimeout(3000);
  const card = await dump(c, b, 'b-card');
  await b.locator('[aria-label="you call them"]').fill('alice');
  await L.button(b, 'save').click();
  await b.waitForTimeout(1500);
  await L.button(b, 'allow')
    .click({ timeout: 3000 })
    .catch(() => undefined);
  const bSaved = await waitText(b, /you saved alice/, 20000);
  const answered = await waitText(a, /an answer arrived/, 60000);
  const seal = await dump(c, a, 'a-answer');
  await a
    .getByRole('button', { name: /^(the words match|it matches)$/ })
    .first()
    .click();
  await a.waitForTimeout(1500);
  await L.button(a, 'open the chat')
    .click({ timeout: 4000 })
    .catch(() => undefined);
  await a.waitForTimeout(1500);
  const nameBox = a.locator('[aria-label="you call them"]');
  if (await nameBox.isVisible().catch(() => false)) {
    await nameBox.fill('bob');
    await a.locator('button[type=submit]').first().click();
    await a.waitForTimeout(2500);
  }
  const aChat = await dump(c, a, 'a-chat');
  pair = { A, B, a, b, card, bSaved, answered, seal, aChat };
  return pair;
};

const say = async (pg, line) => {
  const box = pg.locator('textarea:visible, input[aria-label=message]:visible').last();
  await box.fill(line);
  await pg.keyboard.press('Enter');
};

module.exports = {
  h1: {
    title: 'share card: zafu: link, then web link',
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const { a, zafu, web, order } = await cardLinks(z);
        await dump(c, a, 'add');
        // the web page, fetched here (not by zafu): it should send people to install zafu
        const plain = await L.E.pw.chromium.launch({
          executablePath: '/usr/bin/chromium',
          headless: true,
        });
        let page = '';
        try {
          const wp = await plain.newPage({ viewport: { width: 400, height: 800 } });
          await wp.goto(web, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => undefined);
          await wp.waitForTimeout(2000);
          page = L.flat(await L.text(wp));
          await wp.screenshot({ path: `${c.dir}/web-page.png` });
        } finally {
          await plain.close();
        }
        c.file('web-page.txt', page);
        const install =
          /install|get zafu|get it|add (it )?to (chrome|your browser)|chrome web store/i.test(page);
        const ok =
          /^zafu:/.test(zafu) &&
          /^https:\/\/zafu\.pro\//.test(web) &&
          /zafu/.test(order[0]) &&
          /anyone/.test(order[1]) &&
          install;
        return {
          status: ok ? 'pass' : 'fail',
          note: `rows in order ${JSON.stringify(order)}; zafu link "${zafu?.slice(0, 22)}..."; web link "${web?.slice(0, 26)}..."; zafu.pro page (plain browser, no zafu) says install: ${install} "${page.slice(0, 100)}" (${c.dir}/add.png, web-page.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  h2: {
    title: 'add by card link, confirmed back, pair room',
    timeout: 300_000,
    run: async c => {
      const p = await paired(c);
      const ok = !!p.bSaved && !!p.answered && /you can chat|saved your card/.test(p.aChat);
      return {
        status: ok ? 'pass' : 'fail',
        note: `B pasted A's zafu: card: "${p.card.slice(p.card.indexOf('someone'), p.card.indexOf('someone') + 90)}"; B saved: ${!!p.bSaved}; A got "an answer arrived" with the seal: ${!!p.answered}; after "it matches" A's room: "${p.aChat.slice(p.aChat.indexOf('bob'), p.aChat.indexOf('bob') + 110)}" (${c.dir}/a-answer.png, a-chat.png)`,
      };
    },
  },

  h3: {
    title: 'pair room message both ways, offline line goes later',
    timeout: 400_000,
    run: async c => {
      const p = await paired(c);
      const { A, B, a } = p;
      const n = Date.now().toString(36).slice(-4);
      const t0 = Date.now();
      await say(a, `qa hello from a ${n}`);
      // B opens the thread with alice
      const bi = await B.open('/inbox', 'popup.html', 3000);
      await bi.getByText('alice', { exact: true }).first().click();
      await bi.waitForTimeout(2000);
      const gotA = await waitText(bi, new RegExp(`qa hello from a ${n}`), 120000);
      await say(bi, `qa hello from b ${n}`);
      const gotB = await waitText(a, new RegExp(`qa hello from b ${n}`), 120000);
      // a build with pq pair rooms: both threads say the room moved
      const pqBuild = require('fs')
        .readFileSync(require('path').join(c.dist, 'service-worker.js'), 'utf8')
        .includes('zp2:pq-key:');
      const pqRe = /end-to-end encrypted · post-quantum/;
      const pqA = !pqBuild || !!(await waitText(a, pqRe, 60000));
      const pqB = !pqBuild || !!(await waitText(bi, pqRe, 60000));
      // a build that sends chat over nym: no line leaves direct, reading still does
      const fs = require('fs');
      const chatNym = fs
        .readdirSync(c.dist)
        .filter(f => f.endsWith('.js'))
        .some(f =>
          fs
            .readFileSync(require('path').join(c.dist, f), 'utf8')
            .includes('what you send · reading direct'),
        );
      const relayReqs = [A, B]
        .flatMap(z => z.reqs(t0))
        .filter(r => /relay\.zafu\.pro\/bucket/.test(r.url));
      const directPosts = relayReqs.filter(r => r.method === 'POST').length;
      const directReads = relayReqs.filter(r => r.method === 'GET').length;
      const routeOk = !chatNym || (directPosts === 0 && directReads > 0);
      await dump(c, bi, 'b-thread');
      // B goes offline, says a line, comes back
      await B.offline(true);
      await say(bi, `qa offline line ${n}`);
      await bi.waitForTimeout(4000);
      const offT = await dump(c, bi, 'b-offline');
      const early = await waitText(a, new RegExp(`qa offline line ${n}`), 15000);
      await B.offline(false);
      const late = await waitText(a, new RegExp(`qa offline line ${n}`), 120000);
      await dump(c, a, 'a-thread');
      const status = (offT.match(new RegExp(`qa offline line ${n}.{0,30}`)) ?? [''])[0];
      const ok = gotA && gotB && !early && late && pqA && pqB && routeOk;
      return {
        status: ok ? 'pass' : 'fail',
        note: `A->B arrived: ${!!gotA}; B->A arrived: ${!!gotB}; ${chatNym ? `relay POSTs direct ${directPosts}, reads direct ${directReads}; ` : ''}post-quantum ${pqBuild ? `shown A ${pqA} B ${pqB}` : 'not in this build'}; B offline line shows "${status}"; reached A while B offline: ${!!early}; after B back online: ${!!late} (${c.dir}/b-thread.png, b-offline.png, a-thread.png)`,
      };
    },
  },

  h4: {
    title: 'group chat by door code',
    timeout: 400_000,
    run: async c => {
      const p = await paired(c);
      const { A, B } = p;
      const g = await A.open('/inbox/new-group', 'popup.html', 2000);
      await L.clickText(g, 'group chat').catch(() => undefined);
      const inputs = g.locator('input:visible');
      await inputs.first().fill('qa group');
      if ((await inputs.count()) > 1) {
        await inputs.nth(1).fill('alice');
      }
      await L.button(g, 'invite and create').click();
      await g.waitForTimeout(3000);
      await L.button(g, 'allow')
        .click({ timeout: 3000 })
        .catch(() => undefined);
      const CODE = /\b\d{2,4}-[a-z]+-[a-z]+\b/;
      const inv = await waitText(g, CODE, 30000);
      await dump(c, g, 'a-invite');
      const code = ((inv ?? '').match(CODE) ?? [])[0];
      if (!code) {
        return {
          status: 'fail',
          note: `no door code on A's invite screen: "${(inv ?? L.flat(await L.text(g))).slice(0, 160)}" (${c.dir}/a-invite.png)`,
        };
      }
      const j = await B.open('/inbox/join', 'popup.html', 2000);
      const ji = j.locator('input:visible');
      await ji.first().fill(code);
      if ((await ji.count()) > 1) {
        await ji.nth(1).fill('bob');
      }
      await L.button(j, 'join').click();
      await j.waitForTimeout(3000);
      await L.button(j, 'allow')
        .click({ timeout: 3000 })
        .catch(() => undefined);
      await dump(c, j, 'b-joining');
      // A lets B in, if asked
      const ask = await waitText(g, /asks|wants to join|let (them )?in|knock/, 60000);
      await dump(c, g, 'a-ask');
      await g
        .getByRole('button', { name: /let .*in|admit|accept|yes/i })
        .first()
        .click({ timeout: 5000 })
        .catch(() => undefined);
      const bIn = await waitText(j, /qa group/, 60000);
      await dump(c, j, 'b-group');
      await say(j, 'qa group line from b').catch(() => undefined);
      const ag = await A.open('/inbox', 'popup.html', 3000);
      await ag
        .getByText('qa group', { exact: true })
        .first()
        .click()
        .catch(() => undefined);
      const seen = await waitText(ag, /qa group line from b/, 90000);
      await dump(c, ag, 'a-group');
      return {
        status: bIn && seen ? 'pass' : 'fail',
        note: `door code "${code}"; A saw the ask: ${!!ask}; B in the group: ${!!bIn}; B's line reached A's group thread: ${!!seen} (${c.dir}/a-invite.png, b-joining.png, a-ask.png, a-group.png)`,
      };
    },
  },

  h6: {
    title: 'discovery on by default, off stops it',
    timeout: 400_000,
    run: async c => {
      const fresh = await L.launch(c.dist);
      let on;
      try {
        await L.importSeed(fresh, L.genPhrase(24));
        const pg = await fresh.open('/settings/people', 'popup.html', 2000);
        on = await pg
          .getByRole('switch', { name: 'contact discovery', exact: true })
          .getAttribute('aria-checked');
        await c.shot(pg, 'fresh-people');
      } finally {
        await fresh.close();
      }
      // discovery runs only when a site asks: the paired profile A (it holds bob) and a local dapp
      const { startDapp, waitPage } = require('./checks-install.cjs');
      const { A } = await paired(c);
      const d = await startDapp();
      try {
        const page = await A.ctx.newPage();
        await page.goto(d.url);
        await page.waitForTimeout(1500);
        const ask = msg =>
          page.evaluate(
            ([id, msg]) =>
              new Promise(r => {
                chrome.runtime.sendMessage(id, msg, v =>
                  r(v ?? String(chrome.runtime.lastError?.message)),
                );
                setTimeout(() => r('pending'), 40000);
              }),
            [A.id, msg],
          );
        const DISC = r =>
          /relay\.zafu\.pro\/bucket/.test(r.url) &&
          !/appScope=zafu-(group|pair|door)-v1/.test(r.url);
        const grantP = ask({ type: 'zafu_request_contact_discovery' });
        const w = await waitPage(A, /approval\/contact-discovery/, 20000);
        if (w) {
          await w.waitForTimeout(1500);
          await c.shot(w, 'grant');
          await L.button(w, 'show friends')
            .click()
            .catch(() => undefined);
        }
        const grant = await grantP;
        const t1 = Date.now();
        const onRes = await ask({
          type: 'zafu_discover_contacts',
          appScope: new URL(d.url).origin,
        });
        await L.sleep(5000);
        const onReqs = A.reqs(t1).filter(DISC);
        const sp = await A.open('/settings/people', 'popup.html', 1500);
        await L.toggle(sp, 'contact discovery', false);
        const t2 = Date.now();
        const offRes = await ask({
          type: 'zafu_discover_contacts',
          appScope: new URL(d.url).origin,
        });
        await L.sleep(30000);
        const offReqs = A.reqs(t2).filter(DISC);
        await L.toggle(sp, 'contact discovery', true);
        c.file('discovery.json', {
          grant,
          onRes,
          offRes,
          onReqs: onReqs.map(r => r.url),
          offReqs: offReqs.map(r => r.url),
        });
        const worked = onRes && typeof onRes === 'object' && 'contacts' in onRes;
        const stopped = offRes?.code === 'not_available' && offReqs.length === 0;
        return {
          status: on === 'true' && worked && stopped ? 'pass' : 'fail',
          note: `fresh wallet: contact discovery ${on === 'true' ? 'on' : 'off'}; a local site asked (grant ${JSON.stringify(grant).slice(0, 40)}): on -> ${JSON.stringify(onRes).slice(0, 80)} with ${onReqs.length} discovery relay requests; off -> ${JSON.stringify(offRes).slice(0, 80)} and ${offReqs.length} discovery requests in 30s (${c.dir}/discovery.json)`,
        };
      } finally {
        d.server.close();
      }
    },
  },
};

// a person types on both sides right after pairing: every line reaches the other side
module.exports.pq1 = {
  title: 'lines typed on both sides right after pairing all arrive',
  timeout: 900_000,
  noRetry: true,
  run: async c => {
    const { B, a } = await paired(c);
    const n = Date.now().toString(36).slice(-4);
    await say(a, `a1 ${n}`);
    const bi = await B.open('/inbox', 'popup.html', 2500);
    await bi.getByText('alice', { exact: true }).first().click();
    await bi.waitForTimeout(1500);
    await say(bi, `b1 ${n}`);
    await say(a, `a2 ${n}`);
    await say(bi, `b2 ${n}`);
    const want = { a: [`b1 ${n}`, `b2 ${n}`], b: [`a1 ${n}`, `a2 ${n}`] };
    const t0 = Date.now();
    let ta = '';
    let tb = '';
    const all = () => want.a.every(w => ta.includes(w)) && want.b.every(w => tb.includes(w));
    while (Date.now() - t0 < 240000) {
      ta = L.flat(await L.text(a));
      tb = L.flat(await L.text(bi));
      if (all()) {
        break;
      }
      await a.waitForTimeout(5000);
    }
    await c.shot(a, 'a');
    await c.shot(bi, 'b');
    c.file('a.txt', ta);
    c.file('b.txt', tb);
    return {
      status: all() ? 'pass' : 'fail',
      note: `${Math.round((Date.now() - t0) / 1000)}s; A got ${want.a.map(w => ta.includes(w))}; B got ${want.b.map(w => tb.includes(w))}; post-quantum line A ${/post-quantum/.test(ta)} B ${/post-quantum/.test(tb)} (${c.dir}/a.png, b.png)`,
    };
  },
};

// the bell: on for B rings when A writes; A (off) stays silent
module.exports.snd1 = {
  title: 'sound for messages rings only where it is on',
  timeout: 600_000,
  noRetry: true,
  run: async c => {
    const { A, B, a } = await paired(c);
    const set = await B.open('/settings/display', 'popup.html', 2000);
    await L.toggle(set, 'sound for messages', true);
    await set.close();
    const bi = await B.open('/inbox', 'popup.html', 3000);
    const spy = pg =>
      pg.evaluate(() => {
        const w = window;
        w.__chimes = [];
        const o = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          w.__chimes.push(this.src.split('/').pop());
          return o.call(this);
        };
      });
    const logs = [];
    bi.on('console', m => logs.push(m.text().slice(0, 160)));
    bi.on('pageerror', e => logs.push('ERR ' + e.message.slice(0, 160)));
    // one window plays when several are open: listen on every zafu window of each side
    const bPages = B.ctx.pages().filter(p => p.url().startsWith('chrome-extension://'));
    const aPages = A.ctx.pages().filter(p => p.url().startsWith('chrome-extension://'));
    for (const pg of [...bPages, ...aPages]) {
      await spy(pg).catch(() => undefined);
    }
    const heardBy = async pages =>
      (
        await Promise.all(pages.map(pg => pg.evaluate(() => window.__chimes ?? []).catch(() => [])))
      ).flat();
    const n = Date.now().toString(36).slice(-4);
    await say(a, `ring ${n}`);
    const t0 = Date.now();
    let heard = [];
    while (Date.now() - t0 < 90000 && !heard.length) {
      await bi.waitForTimeout(2000);
      heard = await heardBy(bPages);
    }
    const aHeard = await heardBy(aPages);
    const arrived = L.flat(await L.text(bi)).includes(`ring ${n}`);
    const setting = await bi.evaluate(
      async () => (await chrome.storage.local.get('privacySettings')).privacySettings,
    );
    const state = await bi.evaluate(() => {
      const s = window.__zafuStore?.getState?.();
      return { hasStore: !!s, sound: s?.privacy?.settings?.soundMessages };
    });
    const direct = await bi.evaluate(async () => {
      const locks = !!navigator.locks;
      try {
        await new Audio(chrome.runtime.getURL('sounds/message.wav')).play();
        return { locks, play: 'ok', chimes: window.__chimes };
      } catch (e) {
        return { locks, play: String(e), chimes: window.__chimes };
      }
    });
    c.file('dbg.json', {
      arrived,
      setting,
      state,
      url: bi.url(),
      direct,
      logs: logs.filter(l => !/\[nym\]|egress/.test(l)).slice(-30),
    });
    const ok = heard.includes('message.wav') && aHeard.length === 0;
    return {
      status: ok ? 'pass' : 'fail',
      note: `line in B's inbox ${arrived}; setting ${JSON.stringify(setting)?.slice(0, 120)}; B (on) played ${JSON.stringify(heard)} after ${Math.round((Date.now() - t0) / 1000)}s; A (off) played ${JSON.stringify(aHeard)}`,
    };
  },
};

// read receipts: both on, B reads, A sees "read"; with B's off, A sees none
module.exports.rc1 = {
  title: 'read receipts show only where both turned them on',
  timeout: 900_000,
  noRetry: true,
  run: async c => {
    const { A, B, a } = await paired(c);
    const on = async (Z, who) => {
      const pg = await Z.open('/contacts', 'popup.html', 2000);
      await pg.getByText(who, { exact: true }).first().click();
      await pg.waitForTimeout(1500);
      await L.toggle(pg, 'read receipts', true);
      await pg.waitForTimeout(800);
      await pg.close();
    };
    await on(A, 'bob');
    await on(B, 'alice');
    const n = Date.now().toString(36).slice(-4);
    await say(a, `read me ${n}`);
    const bi = await B.open('/inbox', 'popup.html', 3000);
    await bi.getByText('alice', { exact: true }).first().click();
    const got = await waitText(bi, new RegExp(`read me ${n}`), 300000);
    const read = await waitText(a, /read \d\d:\d\d/, 300000);
    await c.shot(a, 'a-read');
    return {
      status: got && read ? 'pass' : 'fail',
      note: `B got the line: ${!!got}; A shows "read hh:mm": ${!!read} (${c.dir}/a-read.png)`,
    };
  },
};

module.exports.done = async () => {
  if (pair) {
    await pair.A.close();
    await pair.B.close();
    pair = undefined;
  }
};
module.exports._paired = paired;
