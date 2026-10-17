// testnet money helpers: a wallet from a seed file in a brand-new profile (a relaunched profile
// never brings nym back, see t-nym-restart), and the send screen driven like a person would.
// TAZ only: the build must be ZAFU_TESTNET=1 and the node tzcash.rotko.net.
const path = require('path');
const L = require('./lib.cjs');
const T = require('./testnet.cjs');

const BIRTHDAY = 4_480_100;
const NYM_CUT = (host, port) => port === '9001' || /(^|\.)nymtech\.net$/.test(host);

// a fresh profile on `seed` (seed.txt, seed-b.txt, seed-c.txt), synced to the tip
const wallet = async (c, seed, o = {}) => {
  const profile = path.join(c.dir, `profile-${seed.replace(/\W/g, '')}-${Date.now().toString(36)}`);
  const z = await L.launch(c.dist, { profile, password: T.secret(c.tn, 'password.txt') });
  if (o.cutNym) {
    z.proxy.setCut(NYM_CUT);
  }
  // auto-lock reloads the extension, which headless chromium never brings back: off here
  await z.set({ networkEndpoints: { zcash: T.NODE }, autoLockMinutes: 0 });
  await L.importSeed(z, T.secret(c.tn, seed), {
    password: z.password,
    birthday: o.birthday ?? BIRTHDAY,
  });
  await z.sw().evaluate(async b => {
    const all = await chrome.storage.local.get(null);
    const ks = Object.keys(all).filter(k => k.startsWith('zcashBirthday_'));
    await chrome.storage.local.set(Object.fromEntries(ks.map(k => [k, b])));
  }, o.birthday ?? BIRTHDAY);
  await T.setNode(z);
  await z.set({ autoLockMinutes: 0 });
  await T.syncToTip(z, 10 * 60_000);
  const home = await z.open('/', 'popup.html', 2500);
  await L.button(home, 'keep history')
    .click({ timeout: 2500 })
    .catch(() => undefined);
  await home.close();
  z.seed = seed;
  return z;
};

const balances = async z => {
  const pg = await z.open('/', 'popup.html', 3000);
  await L.button(pg, 'keep history')
    .click({ timeout: 1000 })
    .catch(() => undefined);
  const t = L.flat(await L.text(pg));
  await pg.close();
  const num = re => +((t.match(re) ?? [])[1] ?? NaN);
  return {
    // amounts carry a decimal point: "1 min ago" on the transparent line is not one
    shielded: num(/shielded private (\d+\.\d+)/),
    transparent: num(/transparent public(?:(?!activity).){0,40}?(\d+\.\d{3,})/) || 0,
    text: t.slice(0, 200),
  };
};

// sync again and wait until `pred(balances)` holds
const waitBalance = async (z, pred, ms = 20 * 60_000) => {
  const t0 = Date.now();
  let b;
  while (Date.now() - t0 < ms) {
    await T.syncToTip(z, 5 * 60_000).catch(() => undefined);
    b = await balances(z);
    if (pred(b)) {
      return { ...b, waited: Math.round((Date.now() - t0) / 1000) };
    }
    await L.sleep(20000);
  }
  return { ...b, waited: -1 };
};

const fill = async (pg, { to, amount, memo, max }) => {
  await pg.locator('input[placeholder="address or contact"]').fill(to);
  if (max) {
    await L.button(pg, 'max').click();
  } else {
    await pg.locator('input[inputmode=decimal]').first().fill(String(amount));
  }
  if (memo !== undefined) {
    await pg
      .locator('textarea:visible, input[placeholder^="optional"]:visible')
      .first()
      .fill(memo)
      .catch(() => undefined);
  }
  await pg.waitForTimeout(1500);
};

/**
 * one send from the send screen. `onHeld`: what to answer if nym can't be reached
 * ("don't send" or "send directly instead"); `stopAt`: press "stop this send" once the
 * screen shows this stage. returns what the screens said and how it ended.
 */
const send = async (z, c, o) => {
  const tag = o.tag ?? 'send';
  const pg = o.page ?? (await z.open(o.route ?? '/send', 'popup.html', 2500));
  await z.unlock(pg);
  await fill(pg, o);
  const form = L.flat(await L.text(pg));
  const review = L.button(pg, 'review');
  if (!(await review.isEnabled().catch(() => false))) {
    await c.shot(pg, `${tag}-form`);
    return { outcome: 'review-disabled', form, pg };
  }
  await review.click();
  await pg.waitForTimeout(2500);
  const rev = L.flat(await L.text(pg));
  await c.shot(pg, `${tag}-review`);
  const fee = (rev.match(/fee ([\d.]+) zec/) ?? [])[1];
  const t0 = Date.now();
  if (o.stopFast) {
    // a slower build, so stopping has the moment a person would have
    await z.slow(1500);
  }
  await L.button(pg, 'confirm and send').click();
  if (o.stopFast) {
    // a build takes seconds here: press stop the moment it is offered
    const stop = pg.getByRole('button', { name: 'stop this send' });
    const hit = await stop.click({ timeout: 15000 }).then(
      () => true,
      () => false,
    );
    o.stopAt = /./;
    o.stopHit = hit;
  }
  await pg.waitForTimeout(800);
  await z.unlock(pg);
  let outcome = 'timeout',
    held = '',
    stopped = '';
  let last = '';
  while (Date.now() - t0 < (o.ms ?? 10 * 60_000)) {
    await pg.waitForTimeout(1000);
    last = L.flat(await L.text(pg));
    if (o.stopAt && !stopped && o.stopAt.test(last)) {
      await c.shot(pg, `${tag}-before-stop`);
      await L.button(pg, 'stop this send')
        .click()
        .catch(() => undefined);
      stopped = last.slice(0, 200);
      await pg.waitForTimeout(3000);
      last = L.flat(await L.text(pg));
      outcome = 'stopped';
      break;
    }
    if (
      /nym isn't reachable right now|nym didn't answer in time/.test(last) &&
      !held &&
      (await L.button(pg, o.onHeld ?? 'send directly instead')
        .isVisible()
        .catch(() => false))
    ) {
      held = (last.match(/(nym isn't reachable right now|nym didn't answer in time).{0,160}/) ?? [
        '',
      ])[0];
      await c.shot(pg, `${tag}-held`);
      if (o.onHeld === null) {
        outcome = 'held';
        break;
      }
      // a send that is not about nym goes on directly, as a person may choose
      await L.button(pg, o.onHeld ?? 'send directly instead').click();
      if (o.onHeld === "don't send") {
        await pg.waitForTimeout(3000);
        last = L.flat(await L.text(pg));
        outcome = 'declined';
        break;
      }
    }
    if (
      /view transaction|\bsent\b.{0,40}(to|zec)|on its way|in the mempool|mined/i.test(last) &&
      !/sending /.test(last.slice(0, 40))
    ) {
      outcome = 'complete';
      break;
    }
    if (
      /something broke|could not send|failed/i.test(last) &&
      !/nym didn't answer|nym did not answer/.test(last)
    ) {
      outcome = 'failed';
      break;
    }
  }
  await c.shot(pg, `${tag}-end`);
  const secs = Math.round((Date.now() - t0) / 1000);
  const txid = (last.match(/\b[0-9a-f]{64}\b/) ?? [])[0];
  c.file(`${tag}.json`, {
    o: { ...o, to: o.to?.slice(0, 20) },
    form,
    rev,
    held,
    stopped,
    last,
    secs,
    outcome,
  });
  return {
    outcome,
    fee,
    rev,
    held,
    stopped,
    last,
    secs,
    txid,
    pg,
    t0,
    stopHit: o.stopHit,
    stopShot: o.stopShot,
    direct: !!held && o.onHeld === undefined,
  };
};

// the newest activity row, opened: its text and any txid on it
const newestTx = async z => {
  const pg = await z.open('/activity', 'popup.html', 3000);
  const list = L.flat(await L.text(pg));
  const row = pg.locator('[role=button]').filter({ hasText: /zec/ }).first();
  await row.click().catch(() => undefined);
  await pg.waitForTimeout(2500);
  const detail = L.flat(await L.text(pg));
  return { pg, list, detail, txid: (detail.match(/\b[0-9a-f]{64}\b/) ?? [])[0] };
};

module.exports = { wallet, balances, waitBalance, send, newestTx, NYM_CUT, BIRTHDAY };
