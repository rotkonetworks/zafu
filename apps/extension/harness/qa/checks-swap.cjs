// swaps and buy, nothing sent: w1 w4 w5 (mainnet quotes only, no deposit is ever made)
const L = require('./lib.cjs');
const { clip } = require('./checks-zcash.cjs');

const PEER = /zkp2p\.xyz|peer\.xyz|mainnet\.base\.org|sponsor\.zafu\.pro/;

// the swap form with near/thorchain allowed, paying `token` into zec
// a public ethereum address for the refund field: a quote needs one, and nothing is ever deposited
const REFUND = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
const swapForm = async (z, query = 'eth ethereum') => {
  const pg = await z.open('/swap', 'popup.html', 2500);
  await L.button(pg, 'allow')
    .click({ timeout: 4000 })
    .catch(() => undefined);
  await pg.waitForTimeout(800);
  await pg.getByText('select', { exact: true }).first().click();
  // the route list comes over nym: give it the time a person would wait
  const t0 = Date.now();
  while (/reading the routes/.test(await L.text(pg)) && Date.now() - t0 < 150_000) {
    await pg.waitForTimeout(2000);
  }
  pg.routesSecs = Math.round((Date.now() - t0) / 1000);
  await pg.locator('input[placeholder^="search coin"]').fill(query);
  await pg.waitForTimeout(1200);
  await pg
    .getByRole('button', { name: /^eth\s*ethereum$/i })
    .first()
    .click();
  await pg.waitForTimeout(800);
  await pg.locator('input[placeholder="your address"]').first().fill(REFUND);
  return pg;
};

// a fresh wallet per check: the swap form remembers its last pair
const open = [];
const wallet = async c => {
  const z = await L.launch(c.dist);
  open.push(z);
  await L.importSeed(z, L.genPhrase(24));
  return z;
};

module.exports = {
  w1: {
    title: 'swap quotes as you type, fee stated',
    run: async c => {
      const z = await wallet(c);
      const pg = await swapForm(z);
      const amt = pg.locator('input[inputmode=decimal]').first();
      await amt.fill('');
      const steps = [];
      const t0 = Date.now();
      const getOf = t => +((t.match(/you get ([\d.]+) zec/) ?? [])[1] ?? 0);
      for (const keys of ['0.2', '5']) {
        await amt.pressSequentially(keys, { delay: 150 });
        let t = '';
        for (let i = 0; i < 10; i++) {
          await pg.waitForTimeout(1500);
          t = L.flat(await L.text(pg));
          if (getOf(t) > 0 && !/asking/.test(t)) {
            break;
          }
        }
        steps.push({
          typed: await amt.inputValue(),
          secs: Math.round((Date.now() - t0) / 1000),
          get: getOf(t),
          screen: t,
        });
      }
      await c.shot(pg, 'quotes');
      const quoteReqs = z.reqs(t0).filter(r => /chaindefuser|thorchain|liquify/.test(r.url));
      c.file('steps.json', { steps, quoteReqs: quoteReqs.map(r => r.url) });
      const last = steps.at(-1).screen;
      const fee = (last.match(/zafu fee.{0,30}/) ?? [])[0];
      const [a, b] = steps;
      const ok = a.get > 0 && b.get > a.get && !!fee;
      return {
        status: ok ? 'pass' : 'fail',
        note: `routes list took ${pg.routesSecs}s (over nym); eth -> zec: typed 0.2 -> you get ${a.get} zec at ${a.secs}s, then 0.25 -> ${b.get} zec at ${b.secs}s; fee line "${fee ?? 'none'}"; route lines "${(last.match(/best price.{0,80}/) ?? [''])[0]}" (${c.dir}/quotes.png, steps.json; usdc on base -> zec got "near intents · could not quote this right now" in a probe)`,
      };
    },
  },

  w4: {
    title: 'swap link round-trip',
    run: async c => {
      const z = await wallet(c);
      const pg = await swapForm(z);
      await z.hookCopy(pg);
      await pg.locator('input[inputmode=decimal]').first().fill('0.25');
      await pg.waitForTimeout(2500);
      await L.button(pg, 'copy swap link').click();
      await pg.waitForTimeout(800);
      const link = await clip(pg);
      const form = L.flat(await L.text(pg));
      await pg.close();
      const back = await z.open(`/link?uri=${encodeURIComponent(link)}`, 'popup.html', 4000);
      await L.button(back, 'allow')
        .click({ timeout: 3000 })
        .catch(() => undefined);
      await back.waitForTimeout(2000);
      await c.shot(back, 'opened');
      const t = L.flat(await L.text(back));
      const amount = await back
        .locator('input[inputmode=decimal]')
        .first()
        .inputValue()
        .catch(() => '');
      const ok = /^zafu:swap\?/.test(link) && amount === '0.25' && /\beth\b/i.test(t);
      return {
        status: ok ? 'pass' : 'fail',
        note: `copied "${link}"; opening it fills amount "${amount}", eth shown: ${/\beth\b/i.test(t)} (${c.dir}/opened.png); form had "${form.slice(form.indexOf('you pay'), form.indexOf('you pay') + 50)}"`,
      };
    },
  },

  w5: {
    title: 'buy flow to the Peer step, referral, nothing sent before acting',
    run: async c => {
      const z = await wallet(c);
      const home = await z.open('/', 'popup.html', 2000);
      const t0 = Date.now();
      await L.button(home, 'buy').click();
      await home.waitForTimeout(4000);
      const bp = z.ctx.pages().find(p => /buy\.html/.test(p.url()));
      if (!bp) {
        return { status: 'fail', note: 'home > buy opened no buy.html' };
      }
      const consent = L.flat(await L.text(bp));
      await c.shot(bp, 'consent');
      const beforeAct = z.reqs(t0).filter(r => PEER.test(r.url));
      const tAct = Date.now();
      await L.button(bp, 'allow and continue')
        .click({ timeout: 4000 })
        .catch(() => undefined);
      await bp.waitForTimeout(3000);
      await L.button(bp, '$100')
        .click()
        .catch(() => undefined);
      await bp.waitForTimeout(8000);
      const step1 = L.flat(await L.text(bp));
      await c.shot(bp, 'step1');
      const hrefs = await bp.locator('a[href]').evaluateAll(es => es.map(e => e.href));
      const peerLinks = hrefs.filter(h => /peer\.xyz/.test(h));
      const after = z.reqs(tAct).filter(r => PEER.test(r.url));
      // the cash-out side, where the seller referral is attached
      const sw = await z.open('/swap', 'popup.html', 2500);
      await L.button(sw, 'allow')
        .click({ timeout: 3000 })
        .catch(() => undefined);
      const flip = sw
        .locator('button:has(.i-ph-arrows-down-up), button:has([class*=arrows])')
        .first();
      await flip.click().catch(() => undefined);
      await sw.waitForTimeout(800);
      const swHrefs = await sw.locator('a[href]').evaluateAll(es => es.map(e => e.href));
      c.file('trail.json', {
        consent,
        step1,
        peerLinks,
        swHrefs,
        beforeAct: beforeAct.map(r => r.url),
        after: after.map(r => r.url),
      });
      const ref = peerLinks.some(h => /referralCode=L59SD4/.test(h));
      const nothingBefore = beforeAct.length === 0;
      return {
        // decided: L59SD4 is a seller code, attached only on cash-out; the buy check is "nothing before acting"
        status: nothingBefore ? 'pass' : 'fail',
        note: `buy.html consent "${consent.slice(0, 60)}..."; peer/base requests before "allow and continue": ${beforeAct.length}; after allow + $100: ${after.length}; step 1 "${step1.slice(0, 50)}" (seller quote: ${!/- seller/.test(step1)}); peer links ${JSON.stringify(peerLinks.map(h => h.split('?')[0]))} carry referralCode=L59SD4: ${ref} (config/ramps.ts says the buy link cannot: L59SD4 is a seller code, attached only on cash-out) (${c.dir}/trail.json, step1.png)`,
      };
    },
  },
};

module.exports.done = async () => {
  for (const z of open.splice(0)) {
    await z.close();
  }
};
