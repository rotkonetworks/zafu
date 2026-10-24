// Real screens for the Chrome Web Store images (compose.py frames them).
// usage (repo root): node docs/cws-listing/tools/capture.cjs <unpacked build> docs/cws-listing/images/raw
// Runs the build headless on the public bip39 test vector (no funds) and waits
// for sync, so the home screen shows a balance and not its loading box.
const path = require('path');
const fs = require('fs');
const L = require('../../../apps/extension/harness/qa/lib.cjs');

const [dist, out] = process.argv.slice(2);
const PHRASE = 'abandon '.repeat(23) + 'art';

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const z = await L.launch(dist, {
    contextOpts: { viewport: { width: 400, height: 628 }, deviceScaleFactor: 2 },
  });
  try {
    // the welcome page, wide, before a wallet exists
    const w = await z.ctx.newPage();
    await w.setViewportSize({ width: 1280, height: 800 });
    await w.goto(z.url('/welcome', 'page.html'));
    await w.waitForTimeout(2500);
    await w.screenshot({ path: path.join(out, 'welcome-wide.png') });
    await w.close();

    console.log('onboarding:', await L.importSeed(z, PHRASE, { birthdayPreset: 'this month' }));
    // wait out the sync (up to ~15 min) so balances are real, not placeholders
    const home = await z.open('/', 'popup.html', 3000);
    // done = no sync strip and a balance figure (the strip can be absent
    // before sync starts, so its absence alone is not enough)
    const synced = async () => {
      const t = L.flat(await L.text(home));
      return !/syncing/.test(t) && /balance [\d.,]+ zec/.test(t);
    };
    for (let i = 0; i < 180 && !(await synced()); i++) {
      await home.waitForTimeout(5000);
    }
    await home.close();

    const routes = [
      ['home', '/'],
      ['receive', '/receive'],
      ['send', '/send'],
      ['inbox', '/inbox'],
      ['swap', '/swap'],
      ['identity', '/identity'],
      ['settings', '/settings'],
      ['tools', '/tools'],
      ['zigner', '/settings/zigner'],
    ];
    for (const [name, route] of routes) {
      const pg = await z.open(route, 'popup.html', 3500);
      if (
        /unlock|password/i.test(await L.text(pg)) &&
        (await pg.locator('input[type=password]').count())
      ) {
        await z.unlock(pg);
        await pg.goto(z.url(route));
        await pg.waitForTimeout(3500);
      }
      await pg.screenshot({ path: path.join(out, `${name}.png`) });
      console.log('shot', name, L.flat(await L.text(pg)).slice(0, 120));
      await pg.close();
    }
  } finally {
    await z.ctx.close();
    z.proxy?.server?.close?.();
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
