// settings and backup: b1-b4
const path = require('path'),
  { execFileSync } = require('child_process');
const L = require('./lib.cjs');

const dump = async (c, pg, n) => {
  await c.shot(pg, n);
  const t = L.flat(await L.text(pg));
  c.file(n + '.txt', t);
  return t;
};
const fresh = async (c, phrase = L.genPhrase(24)) => {
  const z = await L.launch(c.dist);
  await L.importSeed(z, phrase);
  return z;
};
const nymSheet = async z => {
  const pg = await z.open('/settings/network/connections', 'popup.html', 1500);
  await pg
    .getByRole('button', { name: /^nym, per network/ })
    .first()
    .click();
  await pg.waitForTimeout(800);
  return pg;
};
const explorerRow = async z => {
  const pg = await z.open('/settings/networks/zcash', 'popup.html', 2000);
  const t = L.flat(await L.text(pg));
  return { pg, value: (t.match(/explorer links \? .*? (off|copy|open)\b/) ?? [])[1] };
};

module.exports = {
  b1: {
    title: 'backup export and restore round trip',
    timeout: 400_000,
    run: async c => {
      const phrase = L.genPhrase(24);
      const A = await fresh(c, phrase);
      const pass = 'qa-backup-passphrase-1';
      const file = path.join(c.dir, 'backup.json');
      let set = {};
      try {
        // a contact, a wallet name, a nym choice, an explorer setting
        const r = await A.open('/receive', 'popup.html', 3500);
        const addr = ((await L.text(r)).match(/\bu1[0-9a-z]{100,}/) ?? [])[0];
        await r.close();
        const ct = await A.open('/contacts?add=1', 'popup.html', 1500);
        await ct.waitForTimeout(600);
        await ct.locator('[aria-label=address]').fill(addr);
        await ct.locator('[aria-label=name]').fill('qa backup friend');
        await ct.locator('button[type=submit]').click();
        await ct.waitForTimeout(1000);
        const wl = await A.open('/settings/wallets', 'popup.html', 1500);
        await wl
          .getByRole('button', { name: /^wallet 1/i })
          .first()
          .click();
        await wl.waitForTimeout(600);
        await wl
          .getByRole('button', { name: /^rename/ })
          .first()
          .click();
        await wl.waitForTimeout(400);
        await wl.locator('input:visible').first().fill('qa wallet');
        await wl.keyboard.press('Enter');
        await wl.waitForTimeout(800);
        const ns = await nymSheet(A);
        await L.toggle(ns, 'zcash', false);
        const ex = await explorerRow(A);
        await ex.pg
          .getByRole('button', { name: /^explorer links/ })
          .first()
          .click();
        await ex.pg.waitForTimeout(600);
        await dump(c, ex.pg, 'explorer-sheet');
        await ex.pg
          .getByRole('button', { name: /^copy/ })
          .or(ex.pg.getByRole('radio', { name: /copy/ }))
          .first()
          .click();
        await ex.pg.waitForTimeout(600);
        set = {
          contact: 'qa backup friend',
          wallet: 'qa wallet',
          nymZcash: 'off',
          explorer: (await explorerRow(A)).value,
        };
        // export
        const bk = await A.open('/identity/controls', 'popup.html', 1500);
        await bk
          .getByRole('button', { name: /^back up to a file/ })
          .first()
          .click();
        await bk.waitForTimeout(600);
        const pws = bk.locator('input[type=password]:visible');
        await pws.nth(0).fill(pass);
        await pws.nth(1).fill(pass);
        const dl = bk.waitForEvent('download', { timeout: 15000 });
        await L.button(bk, 'save backup file').click();
        await (await dl).saveAs(file);
      } finally {
        await A.close();
      }
      // restore on a fresh profile, the same phrase imported again (a wipe, then recovery)
      const B = await fresh(c, phrase);
      try {
        const rs = await B.open('/identity/controls', 'popup.html', 1500);
        await rs
          .getByRole('button', { name: /^restore from a file/ })
          .first()
          .click();
        await rs.waitForTimeout(600);
        await rs.locator('input[type=file]').setInputFiles(file);
        await rs.waitForTimeout(800);
        const pw = rs.locator('input[type=password]:visible');
        if (await pw.count()) {
          await pw.first().fill(pass);
        }
        await dump(c, rs, 'restore-sheet');
        await rs
          .getByRole('button', { name: /^restore/ })
          .last()
          .click();
        await rs.waitForTimeout(3000);
        const after = await dump(c, rs, 'restored');
        const contacts = L.flat(await L.text(await B.open('/contacts', 'popup.html', 2000)));
        const wallets = L.flat(await L.text(await B.open('/settings/wallets', 'popup.html', 2000)));
        const ns = await nymSheet(B);
        const nymZ = await ns
          .getByRole('switch', { name: 'zcash', exact: true })
          .getAttribute('aria-checked');
        const exp = (await explorerRow(B)).value;
        const got = {
          contact: /qa backup friend/.test(contacts),
          walletName: /qa wallet/.test(wallets),
          nymZcashOff: nymZ === 'false',
          explorer: exp === set.explorer && exp !== 'off',
        };
        c.file('result.json', { set, got, after, wallets });
        const bad = Object.keys(got).filter(k => !got[k]);
        return {
          status: bad.length ? 'fail' : 'pass',
          note: `set ${JSON.stringify(set)}, exported with a passphrase, restored on a fresh profile after importing the same phrase: ${bad.length ? 'NOT back: ' + bad.join(', ') : 'all back'} (${c.dir}/result.json, restored.png)`,
        };
      } finally {
        await B.close();
      }
    },
  },

  b2: {
    title: 'change password',
    run: async c => {
      const z = await fresh(c);
      try {
        const pg = await z.open('/settings/change-password', 'popup.html', 1500);
        const pws = pg.locator('input[type=password]');
        await pws.nth(0).fill(z.password);
        await pws.nth(1).fill('qa-new-password-2');
        await pws.nth(2).fill('qa-new-password-2');
        await L.button(pg, 'change password').click();
        await pg.waitForTimeout(2500);
        const said = L.flat(await L.text(pg));
        await z.lock();
        const lp = await z.open('/', 'popup.html', 2000);
        await z.unlock(lp, z.password);
        const old = L.flat(await L.text(lp));
        await z.unlock(lp, 'qa-new-password-2');
        const neu = L.flat(await L.text(lp));
        await c.shot(lp, 'after');
        const ok = /that doesn't match/.test(old) && !/welcome back/.test(neu);
        return {
          status: ok ? 'pass' : 'fail',
          note: `after change: "${said.slice(said.indexOf('change password'), said.indexOf('change password') + 80)}"; old password: ${/that doesn't match/.test(old) ? 'refused' : 'ACCEPTED'}; new password unlocks: ${!/welcome back/.test(neu)} (${c.dir}/after.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  b3: {
    title: 'remove a secondary wallet',
    run: async c => {
      const z = await fresh(c);
      try {
        const seedFile = path.join(c.dir, 'second-seed.txt');
        require('fs').writeFileSync(seedFile, L.genPhrase(24), { mode: 0o600 });
        const ufvk = execFileSync('node', [path.join(__dirname, 'ufvk.mjs'), seedFile, 'main'])
          .toString()
          .trim();
        require('fs').rmSync(seedFile);
        const av = await z.open('/settings/add-viewing-key', 'popup.html', 1500);
        await av.locator('textarea, input').first().fill(ufvk);
        await L.button(av, 'add watch-only wallet').click();
        await av.waitForTimeout(3000);
        const before = (await z.storage()).vaults ?? [];
        const first = before.find(v => /^wallet 1$/i.test(v.name));
        const second = before.find(v => v !== first);
        const wl = await z.open('/settings/wallets', 'popup.html', 1500);
        const names = (await wl.getByRole('button').allInnerTexts()).map(s =>
          s.replace(/\s+/g, ' '),
        );
        // the wallet list row (header buttons carry the active wallet's name too)
        await wl
          .locator('button, [role=button]')
          .filter({ hasText: second.name })
          .filter({ hasText: 'watching ·' })
          .first()
          .click();
        await wl.waitForTimeout(600);
        await wl
          .getByRole('button', { name: /^remove wallet/ })
          .first()
          .click();
        await wl.waitForTimeout(1500);
        const confirm = await dump(c, wl, 'confirm');
        const stillTwo = ((await z.storage()).vaults ?? []).length === 2;
        await L.button(wl, 'continue')
          .click()
          .catch(() => undefined);
        await wl.waitForTimeout(1000);
        // the last step asks for the password
        await wl
          .locator('input[type=password]:visible')
          .first()
          .fill(z.password)
          .catch(() => undefined);
        await wl
          .getByRole('button', { name: /^remove/ })
          .last()
          .click({ timeout: 4000 })
          .catch(() => undefined);
        await wl.waitForTimeout(2500);
        await dump(c, wl, 'after');
        const after = (await z.storage()).vaults ?? [];
        const ok =
          before.length === 2 && stillTwo && after.length === 1 && after[0].id === first?.id;
        return {
          status: ok ? 'pass' : 'fail',
          note: `wallets ${JSON.stringify(names.filter(n => /wallet|view/i.test(n)))}; removing "${second?.name}": confirm screen "${confirm.slice(confirm.indexOf('remove'), confirm.indexOf('remove') + 90)}", nothing removed before it: ${stillTwo}; after: ${after.length} wallet(s), wallet 1 kept: ${after[0]?.id === first?.id} (${c.dir}/confirm.png, after.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  b4: {
    title: 'explain sheets open, nothing expands in place',
    run: async c => {
      const z = await fresh(c);
      try {
        const out = [];
        for (const r of [
          '/settings/networks/zcash',
          '/settings/security',
          '/settings/network',
          '/settings/people',
          '/settings/network/connections',
        ]) {
          const pg = await z.open(r, 'popup.html', 2000);
          // rows that wait on the node (server, connection) arrive late: measure once they have
          let settled = -1;
          for (let t = 0; t < 20; t++) {
            const n = await pg.locator('[aria-label^="explain "]').count();
            if (n === settled) {
              break;
            }
            settled = n;
            await pg.waitForTimeout(1000);
          }
          const btns = pg.getByRole('button', { name: /^explain / });
          const n = Math.min(await btns.count(), 3);
          for (let i = 0; i < n; i++) {
            const b = btns.nth(i);
            const label = await b.getAttribute('aria-label');
            const tops = () =>
              pg.evaluate(() =>
                [...document.querySelectorAll('[aria-label^="explain "]')]
                  .filter(e => !e.closest('[role=dialog]'))
                  .map(e => Math.round(e.getBoundingClientRect().top)),
              );
            const rows = await tops();
            await b.click();
            await pg.waitForTimeout(700);
            const dialog = await pg.locator('[role=dialog]:visible').count();
            const text = dialog
              ? L.flat(await pg.locator('[role=dialog]:visible').last().innerText())
              : '';
            const rows2 = await tops();
            out.push({
              route: r,
              label,
              sheet: dialog > 0,
              text: text.slice(0, 80),
              moved: JSON.stringify(rows) !== JSON.stringify(rows2),
              rows,
              rows2,
            });
            if (i === 0) {
              await c.shot(pg, r.replace(/\//g, '_'));
            }
            await pg.keyboard.press('Escape');
            await pg.waitForTimeout(500);
          }
          await pg.close();
        }
        c.file('explain.json', out);
        const bad = out.filter(o => !o.sheet || o.moved);
        return {
          status: out.length >= 10 && !bad.length ? 'pass' : 'fail',
          note: `${out.length} explain buttons on 5 settings screens: ${out.filter(o => o.sheet).length} opened a sheet, ${out.filter(o => o.moved).length} moved the rows behind it${bad.length ? `; bad: ${bad.map(b => `${b.route} ${b.label}`).join(', ')}` : ''} (${c.dir}/explain.json)`,
        };
      } finally {
        await z.close();
      }
    },
  },
};
