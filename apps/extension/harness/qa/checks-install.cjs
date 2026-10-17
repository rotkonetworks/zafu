// install, upgrade, unlock: s2 i1-i8
const path = require('path'),
  fs = require('fs'),
  http = require('http');
const L = require('./lib.cjs');

const BROKE = /unexpected error|page not found|something broke|a brief pause|hit the error/i;

// a local dapp page: it reaches zafu as a site would (externally_connectable on localhost)
const startDapp = () =>
  new Promise(r => {
    const s = http.createServer((_, res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>qa dapp</title><h1>qa test dapp</h1>'),
    );
    s.listen(0, '127.0.0.1', () => r({ server: s, url: `http://localhost:${s.address().port}/` }));
  });
const dappSign = (pg, id) =>
  pg
    .evaluate(
      id =>
        new Promise(r => {
          chrome.runtime.sendMessage(
            id,
            { type: 'zafu_sign', challengeHex: '7161', statement: 'qa harness sign request' },
            v => r(v ?? String(chrome.runtime.lastError?.message)),
          );
          setTimeout(() => r('pending'), 60000);
        }),
      id,
    )
    .catch(e => `page gone: ${e.message.split('\n')[0]}`);

// the newest page whose url matches, waited for
const waitPage = async (z, re, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = z.ctx
      .pages()
      .filter(p => re.test(p.url()))
      .at(-1);
    if (p) {
      return p;
    }
    await L.sleep(300);
  }
  return undefined;
};

module.exports = {
  s2: {
    title: 'About shows the manifest version',
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const pg = await z.open('/settings/devices', 'popup.html', 1500);
        await L.clickText(pg, 'about');
        await pg.waitForTimeout(1200);
        await c.shot(pg, 'about');
        const t = await L.text(pg);
        const v = (t.match(/version (\S+)/) ?? [])[1];
        const man = JSON.parse(fs.readFileSync(path.join(c.dist, 'manifest.json'), 'utf8')).version;
        return {
          status: !!v && man === v ? 'pass' : 'fail',
          note: `about reads "version ${v}", manifest ${man} (${c.dir}/about.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i1: {
    title: 'upgrade from 28.2.0 keeps the wallet',
    timeout: 900_000,
    run: async c => {
      const v282 = c.v282;
      if (!v282 || !fs.existsSync(path.join(v282, 'manifest.json'))) {
        return { status: 'block', note: 'needs --v282 <the unpacked v28.2.0 release zip>' };
      }
      // unpacked without a key: the id comes from the path, so the upgrade reuses this one
      const ext = path.join(c.dir, 'ext'),
        profile = path.join(c.dir, 'profile');
      fs.rmSync(ext, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
      fs.cpSync(v282, ext, { recursive: true });
      // the release zip carries no key (the store assigns the id); the 29.0.0 build pins it.
      // give 28.2.0 the same key so both are one extension, as on the store
      const m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
      m.key = JSON.parse(fs.readFileSync(path.join(c.dist, 'manifest.json'), 'utf8')).key;
      fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(m, null, 2));
      let z = await L.launch(ext, { profile });
      const id282 = z.id;
      const before = {};
      try {
        const pg = await z.open('/welcome/import', 'page.html', 1500);
        await pg.locator('input').first().fill(L.genPhrase(24));
        await pg.waitForTimeout(400);
        const seen = await L.walkButtons(pg, z.password, { done: /wallet ready/ });
        if (!/wallet ready/.test(seen.at(-1))) {
          return { status: 'fail', note: `28.2.0 onboarding stuck at "${seen.at(-1)}"` };
        }
        const ct = await z.open('/contacts', 'popup.html', 2000);
        await L.button(ct, 'not now')
          .click({ timeout: 3000 })
          .catch(() => undefined);
        await L.button(ct, 'add your first contact').click();
        await ct.locator('input[placeholder="alice"]').fill('qa upgrade friend');
        await ct.locator('textarea').fill('kept across the upgrade');
        await L.button(ct, 'save').click();
        await ct.waitForTimeout(1000);
        const st = await z.open('/settings', 'popup.html', 1500);
        await L.button(st, 'appearance').click();
        await st.waitForTimeout(800);
        await st.getByRole('button', { name: /あ/ }).nth(1).click();
        await st.waitForTimeout(800);
        const home = await z.open('/', 'popup.html', 3000);
        await c.shot(home, '282-home');
        before.storage = await z.storage();
        before.contacts = L.flat(await L.text(await z.open('/contacts', 'popup.html', 2000)));
      } finally {
        await z.close();
      }
      // the 29.0.0 build over the same path and profile
      fs.rmSync(ext, { recursive: true, force: true });
      fs.cpSync(c.dist, ext, { recursive: true });
      z = await L.launch(ext, { profile });
      try {
        if (z.id !== id282) {
          return {
            status: 'block',
            note: `harness: 29.0.0 loaded as ${z.id}, 28.2.0 was ${id282}`,
          };
        }
        await L.sleep(3000);
        const pg = await z.open('/', 'popup.html', 3000);
        const locked = await z.unlock(pg);
        await pg.waitForTimeout(3000);
        await c.shot(pg, '29-home');
        const home = L.flat(await L.text(pg));
        const contacts = L.flat(await L.text(await z.open('/contacts', 'popup.html', 2500)));
        const after = await z.storage();
        const lost = Object.keys(before.storage).filter(k => !(k in after));
        const theme = await pg.evaluate(() => document.documentElement.dataset.theme);
        const checks = {
          unlockedWithOldPassword: locked && !/welcome back/.test(home),
          homeShowsWallet: /wallet 1/i.test(home) && /zcash/.test(home),
          noErrorScreen: !BROKE.test(home) && !z.pageErrors.length,
          contactKept: /qa upgrade friend/.test(contacts),
          themeKept: theme === 'washi',
          vaultsKept: JSON.stringify(after.vaults) === JSON.stringify(before.storage.vaults),
        };
        c.file('upgrade.json', { checks, lost, pageErrors: z.pageErrors, home, contacts });
        const bad = Object.keys(checks).filter(k => !checks[k]);
        return {
          status: bad.length ? 'fail' : 'pass',
          note: `28.2.0 (given the 29 build's manifest key, so one extension id ${z.id}) import + contact + washi theme, then 29.0.0 over the same path/profile: ${bad.length ? 'FAILED ' + bad.join(', ') : 'all kept'}; storage keys gone: ${lost.join(',') || 'none'} (${c.dir}/upgrade.json, 29-home.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i2: {
    title: 'fresh 24-word wallet',
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        const r = await L.createWallet(z, c.dir);
        const pg = await z.open('/', 'popup.html', 3000);
        await c.shot(pg, 'home');
        const t = L.flat(await L.text(pg));
        const s = await z.storage();
        const ok =
          r.words === 24 &&
          /wallet ready/.test(r.heading) &&
          /zcash/.test(t) &&
          JSON.stringify(s.enabledNetworks) === '["zcash"]' &&
          s.seedPhraseBackedUp === true;
        return {
          status: ok ? 'pass' : 'fail',
          note: `revealed ${r.words} words, 3-word check passed, "${r.heading}"; home "${t.slice(0, 60)}"; enabledNetworks ${JSON.stringify(s.enabledNetworks)}, backedUp ${s.seedPhraseBackedUp} (${c.dir}/home.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i3: {
    title: '12-word phrase is penumbra-only',
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        const pg = await z.open('/welcome/import', 'page.html', 1200);
        await pg.locator('textarea').first().fill(L.genPhrase(12));
        await pg.waitForTimeout(500);
        const said = L.flat(await L.text(pg));
        await c.shot(pg, 'phrase');
        await pg.locator('button[type=submit]').click();
        await pg.waitForTimeout(1500);
        const next = L.flat(await L.text(pg));
        await c.shot(pg, 'after');
        await L.finishOnboarding(pg, z.password);
        const ready = L.flat(await L.text(pg));
        const s = await z.storage();
        const home = await z.open('/', 'popup.html', 3000);
        await c.shot(home, 'home');
        const homeT = L.flat(await L.text(home));
        const plain = /penumbra/i.test(said + ' ' + next + ' ' + ready);
        const only = JSON.stringify(s.enabledNetworks) === '["penumbra"]';
        return {
          status: only && plain ? 'pass' : 'fail',
          note: `enabledNetworks ${JSON.stringify(s.enabledNetworks)}; birthday step skipped: ${!/exact block/.test(next)}; says penumbra while importing: ${plain} ("${said.slice(0, 120)}" | next "${next.slice(0, 60)}" | ready "${ready.slice(0, 60)}"); home "${homeT.slice(0, 50)}" (${c.dir}/phrase.png, home.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i4: {
    title: 'viewing key, watch-only',
    timeout: 900_000,
    run: async c => {
      // the testnet wallet's own viewing key (TAZ, valueless) so there is a balance to show
      const tn = c.tn;
      if (!tn) {
        return {
          status: 'block',
          note: 'needs --tn <dir> with the funded testnet seed for a ufvk',
        };
      }
      const ufvk = require('child_process')
        .execFileSync('node', [path.join(__dirname, 'ufvk.mjs'), path.join(tn, 'seed.txt'), 'test'])
        .toString()
        .trim();
      const z = await L.launch(c.dist);
      try {
        await z.set({ networkEndpoints: { zcash: 'https://tzcash.rotko.net' } });
        const pg = await z.open('/welcome/import-viewing-key', 'page.html', 1200);
        await pg.locator('textarea, input').first().fill(ufvk);
        await pg.waitForTimeout(500);
        await c.shot(pg, 'key');
        await pg.locator('button[type=submit]').first().click();
        await pg.waitForTimeout(1200);
        const T = require('./testnet.cjs');
        await L.finishOnboarding(pg, z.password, { birthday: 4_480_100 });
        await z.sw().evaluate(async b => {
          const all = await chrome.storage.local.get(null);
          const ks = Object.keys(all).filter(k => k.startsWith('zcashBirthday_'));
          await chrome.storage.local.set(Object.fromEntries(ks.map(k => [k, b])));
        }, 4_480_100);
        await T.setNode(z);
        await T.syncToTip(z, 8 * 60_000);
        const home = await z.open('/', 'popup.html', 4000);
        await c.shot(home, 'home');
        const t = L.flat(await L.text(home));
        const bal = +((t.match(/shielded private ([\d.]+)/) ?? [])[1] ?? 0);
        const send = await z.open('/send', 'popup.html', 3000);
        await c.shot(send, 'send');
        const st = L.flat(await L.text(send));
        const asksSigner =
          /signer|zigner|keystone|watch|view(ing)? only|can't spend|cannot spend/i.test(st);
        return {
          status: bal > 0 && asksSigner ? 'pass' : 'fail',
          note: `testnet uviewtest key of the faucet wallet on the release build (node tzcash): shielded balance ${bal}; send screen "${st.slice(0, 140)}" asks for a signer: ${asksSigner} (${c.dir}/home.png, send.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i5: {
    title: 'restore with birthday height',
    run: async c => {
      const z = await L.launch(c.dist);
      const H = 3_400_000;
      try {
        await L.importSeed(z, L.genPhrase(24), { birthday: H });
        const s = await z.storage();
        const bkey = Object.keys(s).find(k => k.startsWith('zcashBirthday_'));
        const pg = await z.open('/', 'popup.html', 1000);
        let start;
        for (let i = 0; i < 40 && !start; i++) {
          await L.sleep(1000);
          start = z.logs(/\[zcash-worker\] (sync start|blocks \d+)/)[0]?.text;
        }
        await c.shot(pg, 'home');
        const first = +((start ?? '').match(/requested=(\d+)|blocks (\d+)/) ?? [])
          .slice(1)
          .find(Boolean);
        return {
          status: s[bkey] === H && first >= H - 1 && first <= H + 1 ? 'pass' : 'fail',
          note: `exact block ${H} entered; stored birthday ${s[bkey]}; first sync line "${(start ?? 'none').slice(0, 140)}" (finding past notes needs a funded mainnet seed: not run)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i6: {
    title: 'lock/unlock, wrong password copy, auto-lock',
    timeout: 400_000,
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const pg = await z.open('/', 'popup.html', 2000);
        await pg.locator('[aria-label=lock]').first().click();
        await pg.waitForTimeout(1500);
        const lockedText = L.flat(await L.text(pg));
        await pg.locator('input[type=password]').first().fill('not-the-password');
        await pg.keyboard.press('Enter');
        await pg.waitForTimeout(1500);
        const wrong = L.flat(await L.text(pg));
        await c.shot(pg, 'wrong-password');
        const unlocked = await z.unlock(pg);
        const after = L.flat(await L.text(pg));
        // auto-lock at its shortest: 1 min idle, checked by a 1 min alarm
        await z.set({ autoLockMinutes: 1 });
        await z.closeAll();
        const t0 = Date.now();
        let auto;
        while (!auto && Date.now() - t0 < 200_000) {
          await L.sleep(5000);
          auto = z.logs(/\[idle\] auto-locking/, t0)[0];
        }
        const secs = Math.round((Date.now() - t0) / 1000);
        const copyOk =
          /that doesn't match/.test(wrong) && !/wrong password|incorrect|invalid/i.test(wrong);
        const ok =
          /welcome back/.test(lockedText) &&
          copyOk &&
          unlocked &&
          !/welcome back/.test(after) &&
          auto;
        return {
          status: ok ? 'pass' : 'fail',
          note: `header lock -> "${lockedText.slice(0, 40)}"; wrong password says "${(wrong.match(/that doesn't match[^.]*/) ?? ['(none)'])[0]}"; unlock ok ${!/welcome back/.test(after)}; auto-lock at 1 min ${auto ? `fired after ${secs}s idle (worker: "${auto.text}"; it clears the session key, then runtime.reload(), whose return headless chromium 153 never shows, even for a trivial extension)` : 'did not fire in 200s'} (${c.dir}/wrong-password.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i7: {
    title: 'forgot password: erase and restore',
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        const phrase = L.genPhrase(24);
        await L.importSeed(z, phrase);
        await z.lock();
        const pg = await z.open('/', 'popup.html', 2000);
        await L.clickText(pg, 'forgot it? restore with your recovery phrase');
        await pg.waitForTimeout(1200);
        const why = L.flat(await L.text(pg));
        const vaultsBefore = (await z.storage()).vaults?.length;
        await L.button(pg, 'continue').click();
        await pg.waitForTimeout(800);
        const confirm = L.flat(await L.text(pg));
        await c.shot(pg, 'confirm');
        const stillThere = (await z.storage()).vaults?.length;
        const gated = !(await L.button(pg, 'erase and restore').isEnabled());
        await L.toggle(pg, 'i have my phrases and backups', true);
        await L.button(pg, 'erase and restore').click();
        let imp;
        for (let i = 0; i < 30 && !imp; i++) {
          await L.sleep(1000);
          imp = z.ctx.pages().find(p => /welcome\/import/.test(p.url()));
        }
        const erased = !(await z.storage()).vaults?.length;
        let restored = false;
        if (imp) {
          await imp.waitForTimeout(1000);
          await imp.locator('textarea').first().fill(phrase);
          await imp.locator('button[type=submit]').click();
          await imp.waitForTimeout(1200);
          await L.finishOnboarding(imp, 'a-new-password-2');
          restored = (await z.storage()).vaults?.length === 1;
        }
        const ok = vaultsBefore === 1 && stillThere === 1 && gated && erased && restored;
        return {
          status: ok ? 'pass' : 'fail',
          note: `why "${why.slice(0, 80)}"; confirm "${confirm.slice(0, 100)}"; nothing erased before the confirm: ${stillThere === 1}; erase disabled until "i have my phrases and backups": ${gated}; erased after: ${erased}; import opened: ${!!imp}; restored with a new password: ${restored} (${c.dir}/confirm.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  i8: {
    title: 'locked dapp request opens unlock',
    run: async c => {
      const z = await L.launch(c.dist);
      const d = await startDapp();
      try {
        await L.importSeed(z, L.genPhrase(24));
        await z.closeAll();
        await z.lock();
        const page = await z.ctx.newPage();
        await page.goto(d.url);
        await page.waitForTimeout(1500);
        const t0 = Date.now();
        const res = dappSign(page, z.id);
        const w = await waitPage(z, /chrome-extension:/, 20000);
        await w?.waitForTimeout(2500);
        if (w) {
          await c.shot(w, 'opened');
        }
        const wt = w ? L.flat(await L.text(w)) : '';
        const unlockShown =
          !!w && (/welcome back/.test(wt) || (await w.locator('input[type=password]').count()) > 0);
        const r = await Promise.race([res, L.sleep(3000).then(() => 'pending')]);
        return {
          status: unlockShown ? 'pass' : 'fail',
          note: `locked, then zafu_sign from ${d.url}: ${w ? `opened ${w.url().replace(/^chrome-extension:\/\/[a-z]+/, '')} "${wt.slice(0, 80)}"` : 'no zafu window opened'} after ${Math.round((Date.now() - t0) / 1000)}s; page got ${JSON.stringify(r).slice(0, 120)} (${c.dir}/opened.png)`,
        };
      } finally {
        await z.close();
        d.server.close();
      }
    },
  },
};

module.exports.startDapp = startDapp;
module.exports.dappSign = dappSign;
module.exports.waitPage = waitPage;
