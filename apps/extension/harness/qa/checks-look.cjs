// look and shell: l1-l3
const path = require('path'),
  fs = require('fs');
const L = require('./lib.cjs');

const BROKE = /unexpected error|page not found|something broke|a brief pause|hit the error/i;
const MAIN = [
  '/',
  '/receive',
  '/send',
  '/swap',
  '/inbox',
  '/tools',
  '/settings',
  '/settings/network/connections',
  '/settings/networks/zcash',
  '/activity',
  '/identity',
  '/contacts',
];
const TABS = /wallet people tools settings/;

module.exports = {
  l1: {
    title: 'both themes on the main screens: rendered, readable',
    timeout: 600_000,
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const out = [];
        for (const theme of ['sumi', 'washi']) {
          await z.set({ zafuTheme: theme });
          for (const r of MAIN) {
            const pg = await z.open(r, 'popup.html', 2500);
            // a first-visit consent sheet would cover the screen being judged
            await L.button(pg, 'not now')
              .click({ timeout: 1000 })
              .catch(() => undefined);
            await pg.waitForTimeout(400);
            const name = `${theme}${r.replace(/\//g, '_')}`;
            await c.shot(pg, name);
            const t = L.flat(await L.text(pg));
            const scan = await L.contrastScan(pg);
            // sumi is the default and sets no attribute
            const dt = (await pg.evaluate(() => document.documentElement.dataset.theme)) ?? 'sumi';
            out.push({
              theme,
              route: r,
              appliedTheme: dt,
              chars: t.length,
              broke: BROKE.test(t),
              lowContrast: scan.bad,
              nodes: scan.n,
              bodyBg: scan.bodyBg,
            });
            await pg.close();
          }
        }
        await z.set({ zafuTheme: 'sumi' });
        c.file('themes.json', out);
        const blank = out.filter(o => o.chars < 40 || o.broke);
        const wrongTheme = out.filter(o => o.appliedTheme !== o.theme);
        const low = out.filter(o => o.lowContrast.length);
        const ok = !blank.length && !wrongTheme.length && !low.length && !z.pageErrors.length;
        return {
          status: ok ? 'pass' : 'fail',
          note: `${out.length} screens (${MAIN.length} x sumi/washi): blank or error ${blank.length}${blank.length ? ' ' + blank.map(b => `${b.theme}${b.route}`).join(',') : ''}; theme not applied ${wrongTheme.length}; text under 2:1 contrast on ${low.length} screen(s)${
            low.length
              ? ': ' +
                low
                  .slice(0, 4)
                  .map(o => `${o.theme}${o.route} ${o.lowContrast.slice(0, 2).join('; ')}`)
                  .join(' | ')
              : ''
          }; page errors ${z.pageErrors.length} (${c.dir}/themes.json + one png per screen)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  l2: {
    title: 'popup.html and sidepanel.html render; shell everywhere but unlock and approvals',
    timeout: 600_000,
    run: async c => {
      const z = await L.launch(c.dist);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const out = [];
        for (const html of ['popup.html', 'sidepanel.html']) {
          for (const r of [...MAIN, '/approval/sign', '/approval/origin']) {
            const pg = await z.open(r, html, 2000);
            const t = L.flat(await L.text(pg));
            const header = (await pg.locator('[aria-label=lock]').count()) > 0;
            out.push({
              html,
              route: r,
              chars: t.length,
              broke: BROKE.test(t),
              header,
              tabs: TABS.test(t),
              bare: /^\/approval/.test(r),
            });
            if (r === '/') {
              await c.shot(pg, html.replace('.html', ''));
            }
            await pg.close();
          }
          await z.lock();
          const lp = await z.open('/', html, 2000);
          const lt = L.flat(await L.text(lp));
          out.push({
            html,
            route: '/login (locked)',
            chars: lt.length,
            broke: BROKE.test(lt),
            header: (await lp.locator('[aria-label=lock]').count()) > 0,
            tabs: TABS.test(lt),
            bare: true,
            unlockShown: /welcome back/.test(lt),
          });
          await c.shot(lp, html.replace('.html', '') + '-locked');
          await z.unlock(lp);
          await lp.close();
        }
        c.file('shell.json', out);
        // an approval route opened with nothing pending has nothing to show; it must only stay bare
        const bad = out.filter(
          o =>
            (!/^\/approval/.test(o.route) && o.chars < 40) ||
            o.broke ||
            (o.bare ? o.tabs : !(o.header && o.tabs)),
        );
        return {
          status: !bad.length && !z.pageErrors.length ? 'pass' : 'fail',
          note: `${out.length} renders over popup.html and sidepanel.html: shell (header + tabs) on ${out.filter(o => !o.bare && o.header && o.tabs).length}/${out.filter(o => !o.bare).length} app screens; bare unlock/approvals with tabs: ${out.filter(o => o.bare && o.tabs).length}; blank/error ${out.filter(o => (!/^\/approval/.test(o.route) && o.chars < 40) || o.broke).length} (approval routes with no request pending render empty: ${out.filter(o => /^\/approval/.test(o.route) && o.chars < 40).length})${bad.length ? '; bad: ' + bad.map(b => `${b.html}${b.route}`).join(', ') : ''}; page errors ${z.pageErrors.length} (${c.dir}/shell.json)`,
        };
      } finally {
        await z.close();
      }
    },
  },

  l3: {
    title: 'an update while open recovers without a sticky error screen',
    run: async c => {
      // a copy of the build whose lazy chunks go missing under an open popup, as an
      // update swaps files; then the files come back, as the new version is in place
      const ext = path.join(c.dir, 'ext'),
        hidden = path.join(c.dir, 'hidden');
      fs.rmSync(ext, { recursive: true, force: true });
      fs.rmSync(hidden, { recursive: true, force: true });
      fs.cpSync(c.dist, ext, { recursive: true });
      fs.mkdirSync(hidden);
      const z = await L.launch(ext);
      try {
        await L.importSeed(z, L.genPhrase(24));
        const pg = await z.open('/', 'popup.html', 3000);
        // only the chunks nothing has loaded yet: the open page asks for one the update replaced
        const loaded = new Set(
          z.cdp.records
            .map(r => (r.url.match(/^chrome-extension:\/\/[a-z]+\/(\d+\.js)/) ?? [])[1])
            .filter(Boolean),
        );
        const chunks = fs.readdirSync(ext).filter(f => /^\d+\.js$/.test(f) && !loaded.has(f));
        for (const f of chunks) {
          fs.renameSync(path.join(ext, f), path.join(hidden, f));
        }
        await pg.evaluate(() => (location.hash = '#/identity/passwords'));
        await pg.waitForTimeout(4000);
        const during = L.flat(await L.text(pg));
        await c.shot(pg, 'during');
        for (const f of chunks) {
          fs.renameSync(path.join(hidden, f), path.join(ext, f));
        }
        // its own recovery first, then one tap on whatever it offers
        let after = '';
        for (let i = 0; i < 10; i++) {
          await pg.waitForTimeout(1500);
          after = L.flat(await L.text(pg));
          if (/passkeys and passwords/.test(after)) {
            break;
          }
        }
        const selfRecovered = /passkeys and passwords/.test(after);
        if (!selfRecovered) {
          await pg
            .getByRole('button', { name: /begin again|reload|try again|open again/i })
            .first()
            .click()
            .catch(() => undefined);
          await pg.waitForTimeout(4000);
          after = L.flat(await L.text(pg));
        }
        await c.shot(pg, 'after');
        // back on the screen it was going to, or begun again from home: either way not stuck
        const recovered =
          /passkeys and passwords|balance\b.*\breceive/.test(after) && !BROKE.test(after);
        return {
          status: recovered ? 'pass' : 'fail',
          note: `${chunks.length} not-yet-loaded chunks gone under an open popup (${loaded.size} loaded ones kept), then back: during "${during.slice(0, 90)}"; ${selfRecovered ? 'recovered on its own' : recovered ? `recovered after one tap on "begin again" (zafu had already retried once on its own), landing on ${/passkeys/.test(after) ? 'the screen' : 'home'}` : `still "${after.slice(0, 90)}"`} (${c.dir}/during.png, after.png)`,
        };
      } finally {
        await z.close();
      }
    },
  },
};
