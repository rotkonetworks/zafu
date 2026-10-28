// shared pieces of the release QA runner: a recorded browser per profile, popup helpers,
// and the onboarding paths. proxy, CDP recorder and net-log come from egress-leak.cjs.
const path = require('path'),
  fs = require('fs'),
  os = require('os');
const E = require('../egress-leak.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PASSWORD = 'qa-harness-password-1';
// QA_CHROME: another chromium (e.g. playwright's own) while the system one is broken
const CHROME = process.env.QA_CHROME || '/usr/bin/chromium';

// one browser on one profile, every request and console line from every realm recorded
const launch = async (dist, o = {}) => {
  const ext = path.resolve(dist);
  const temp = !o.profile;
  const profile = o.profile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'zafu-qa-'));
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  // a profile reused across launches keeps the port file of the last one
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const proxy = o.proxy === false ? undefined : await E.startProxy();
  // QA_HEADED=1 (under xvfb-run): a drawn side panel, so approvals there become visible
  const headed = process.env.QA_HEADED === '1';
  const ctx = await E.pw.chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: !headed,
    viewport: { width: 400, height: 628 },
    ...(o.contextOpts ?? {}),
    args: [
      ...(headed ? [] : ['--headless=new']),
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--remote-debugging-port=0',
      ...(proxy ? [`--proxy-server=http://127.0.0.1:${proxy.port}`] : []),
      ...(o.netlog ? [`--log-net-log=${o.netlog}`, '--net-log-capture-mode=Default'] : []),
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      ...(o.args ?? []),
    ],
  });
  const cdp = await E.startCdp(profile);
  const sw0 =
    ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 30000 }));
  const id = new URL(sw0.url()).host;
  const sw = () => ctx.serviceWorkers().find(w => w.url().includes(id)) ?? sw0;
  const pageErrors = [];
  const z = { ctx, cdp, id, sw, profile, proxy, pageErrors, password: o.password ?? PASSWORD };
  z.url = (route = '/', html = 'popup.html') => `chrome-extension://${id}/${html}#${route}`;
  z.open = async (route = '/', html = 'popup.html', wait = 1500) => {
    const pg = await ctx.newPage();
    pg.on('pageerror', e => pageErrors.push(`${route}: ${e.message}`));
    await pg.goto(z.url(route, html));
    await pg.waitForTimeout(wait);
    return pg;
  };
  z.storage = (area = 'local') => sw().evaluate(a => chrome.storage[a].get(null), area);
  z.set = (obj, area = 'local') => sw().evaluate(([o, a]) => chrome.storage[a].set(o), [obj, area]);
  z.lock = () =>
    sw().evaluate(() => chrome.storage.session.remove(['passwordKey', 'identityKeys']));
  z.unlock = async (pg, pw = z.password) => {
    const box = pg.locator('input[type=password]').first();
    if (await box.isVisible({ timeout: 3000 }).catch(() => false)) {
      await box.fill(pw);
      await pg.keyboard.press('Enter');
      await pg.waitForTimeout(2500);
      return true;
    }
    return false;
  };
  // the network gone for every realm: CDP offline on each target, new connections refused,
  // and the tunnels already open dropped
  z.offline = async on => {
    proxy?.setCut(() => on);
    if (on) {
      proxy?.drop();
    }
    for (const s of cdp.sessions()) {
      await cdp.send(
        'Network.emulateNetworkConditions',
        { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        s,
      );
    }
  };
  // a slow network on every realm (latency in ms), or back to normal with 0
  z.slow = async ms => {
    for (const s of cdp.sessions()) {
      await cdp.send(
        'Network.emulateNetworkConditions',
        {
          offline: false,
          latency: ms,
          downloadThroughput: ms ? 64 * 1024 : -1,
          uploadThroughput: ms ? 64 * 1024 : -1,
        },
        s,
      );
    }
  };
  // what a copy put on the clipboard: extension origins cannot be granted clipboard-read
  z.hookCopy = pg =>
    pg.evaluate(() => {
      window.__copied = [];
      const w = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = t => (window.__copied.push(t), w(t).catch(() => undefined));
    });
  z.copied = pg => pg.evaluate(() => window.__copied?.at(-1) ?? null);
  // a zafu page Playwright never sees (headless draws the side panel as a bare target):
  // found by url over CDP, then read, clicked and photographed through that session
  z.panel = async (re, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const { targetInfos = [] } = await cdp.send('Target.getTargets');
      const t = targetInfos.filter(x => re.test(x.url)).at(-1);
      if (t) {
        const { sessionId } = await cdp.send('Target.attachToTarget', {
          targetId: t.targetId,
          flatten: true,
        });
        const ev = async expr =>
          (
            await cdp.send(
              'Runtime.evaluate',
              { expression: expr, awaitPromise: true, returnByValue: true },
              sessionId,
            )
          ).result?.value;
        return {
          url: t.url,
          text: () => ev('document.body.innerText'),
          // a real mouse press at the button (approvals ignore untrusted clicks)
          click: async name => {
            const box = await ev(
              `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(name)}) && !b.disabled); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
            );
            if (!box) {
              return false;
            }
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
              await cdp.send(
                'Input.dispatchMouseEvent',
                { type, x: box.x, y: box.y, button: 'left', clickCount: 1 },
                sessionId,
              );
            }
            return true;
          },
          // typed into the first field matching `sel`, as keystrokes would
          type: async (sel, text) => {
            const ok = await ev(
              `(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return false; i.focus(); return true; })()`,
            );
            if (ok) {
              await cdp.send('Input.insertText', { text }, sessionId);
            }
            return !!ok;
          },
          shot: async file => {
            const r = await cdp.send('Page.captureScreenshot', {}, sessionId);
            if (r?.data) {
              fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
            }
          },
        };
      }
      await sleep(400);
    }
    return undefined;
  };
  // every zafu window closed; one blank tab keeps the browser itself alive
  // after a runtime.reload(): the extension is back once a new worker runs
  z.waitBack = async (ms = 45000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const w = ctx.serviceWorkers().find(w => w.url().includes(id));
      const p = w && (await ctx.newPage());
      if (p) {
        const ok = await p.goto(z.url('/')).then(
          () => true,
          () => false,
        );
        await p.close();
        if (ok) {
          return Math.round((Date.now() - t0) / 1000);
        }
      }
      await sleep(1000);
    }
    return -1;
  };
  z.closeAll = async () => {
    const keep = await ctx.newPage();
    for (const p of ctx.pages()) {
      if (p !== keep) {
        await p.close();
      }
    }
    return keep;
  };
  z.reqs = (since = 0) => cdp.records.filter(r => r.t >= since && E.isNet(r.url));
  z.logs = (re, since = 0) => cdp.logs.filter(l => l.t >= since && (!re || re.test(l.text)));
  z.close = async () => {
    await ctx.close().catch(() => undefined);
    cdp.close();
    proxy?.server.close();
    // a throwaway profile goes with its browser; named ones are kept as evidence
    if (temp) {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  };
  return z;
};

const text = pg => pg.evaluate(() => document.body.innerText).catch(() => '');
const flat = s => s.replace(/\s+/g, ' ').trim();
const clickText = (pg, t, o = {}) =>
  pg
    .getByText(t, { exact: o.exact ?? true })
    .first()
    .click({ timeout: o.timeout ?? 5000 });
const button = (pg, name, o = {}) =>
  pg.getByRole('button', { name, exact: o.exact ?? true }).first();

// a Row toggle by its label; returns aria-checked after, as a boolean
const toggle = async (pg, label, want) => {
  const sw = pg.getByRole('switch', { name: label, exact: true }).first();
  if (want === undefined || (await sw.getAttribute('aria-checked')) !== String(want)) {
    await sw.click();
    await pg.waitForTimeout(500);
  }
  return (await sw.getAttribute('aria-checked')) === 'true';
};

// h1 of the onboarding screen, or '' while it changes
const heading = pg =>
  pg
    .locator('h1')
    .first()
    .innerText({ timeout: 3000 })
    .then(
      s => s.trim(),
      () => '',
    );

// walks whatever onboarding screens come after the phrase, to "wallet ready"
const finishOnboarding = async (pg, pw, o = {}) => {
  for (let i = 0; i < 12; i++) {
    const h = await heading(pg);
    if (/set a password/.test(h)) {
      const pws = pg.locator('input[type=password]');
      for (let j = 0; j < (await pws.count()); j++) {
        await pws.nth(j).fill(pw);
      }
      await pg.locator('button[type=submit]').click();
    } else if (
      /when did|began|birthday|start/i.test(h) ||
      (await pg.getByText('exact block').count())
    ) {
      if (o.birthday) {
        await clickText(pg, 'exact block');
        await pg.locator('input[inputmode=numeric]').fill(String(o.birthday));
        await pg.locator('form button[type=submit]').last().click();
        await pg.waitForTimeout(500);
      } else {
        await clickText(pg, o.birthdayPreset ?? 'this month');
      }
      await button(pg, 'continue').click();
    } else if (/make it yours/.test(h)) {
      await button(pg, 'keep defaults').click();
    } else if (/wallet ready/.test(h)) {
      return h;
    } else {
      const ok = pg.getByRole('button', { name: /looks right|continue/ }).first();
      if (await ok.isEnabled({ timeout: 1000 }).catch(() => false)) {
        await ok.click();
      }
    }
    await pg.waitForTimeout(1500);
  }
  throw new Error(`onboarding stuck at "${await heading(pg)}"`);
};

const importSeed = async (z, phrase, o = {}) => {
  const pg = await z.open('/welcome/import', 'page.html', 1200);
  await pg.locator('textarea').first().fill(phrase);
  await pg.locator('button[type=submit]').click();
  await pg.waitForTimeout(1200);
  const h = await finishOnboarding(pg, o.password ?? z.password, o);
  if (!o.keepOpen) {
    await pg.close();
  }
  return h;
};

// the real create path: password, reveal, the 3-word check
const createWallet = async (z, shots) => {
  const pg = await z.open('/welcome', 'page.html', 1200);
  const shot = n => shots && pg.screenshot({ path: path.join(shots, n + '.png') });
  await pg
    .getByRole('button', { name: /create|new wallet/i })
    .first()
    .click();
  await pg.waitForTimeout(800);
  const pws = pg.locator('input[type=password]');
  await pws.nth(0).fill(z.password);
  await pws.nth(1).fill(z.password);
  await pg.locator('button[type=submit]').click();
  await pg.waitForTimeout(1500);
  await clickText(pg, 'tap to reveal', { exact: false });
  await pg.waitForTimeout(500);
  await shot('reveal');
  const words = await pg.locator('ol li span:nth-child(2)').allInnerTexts();
  await button(pg, 'i wrote it down').click();
  await pg.waitForTimeout(800);
  for (let k = 0; k < 3; k++) {
    const t = await text(pg);
    const n = +(t.match(/tap word #(\d+)/) ?? [])[1];
    if (!n) {
      break;
    }
    await pg.getByRole('button', { name: words[n - 1], exact: true }).click();
    await pg.waitForTimeout(700);
  }
  await shot('checked');
  const h = await finishOnboarding(pg, z.password);
  await shot('ready');
  await pg.close();
  return { words: words.length, heading: h };
};

// an older release's onboarding, by its buttons: fill passwords, take the first enabled
// button in `order`, until none is left or `done` matches the page
const walkButtons = async (pg, pw, o = {}) => {
  const order = o.order ?? [
    'looks right, continue',
    "i don't remember",
    'scan from',
    'keep defaults',
    'continue',
    'next',
    'done',
    'got it',
    'skip',
  ];
  const seen = [];
  for (let i = 0; i < (o.max ?? 14); i++) {
    const t = flat(await text(pg));
    seen.push(t.slice(0, 120));
    if (o.done?.test(t)) {
      return seen;
    }
    const pws = pg.locator('input[type=password]:visible');
    for (let j = 0; j < (await pws.count()); j++) {
      await pws.nth(j).fill(pw);
    }
    const names = (await pg.locator('button:visible').allInnerTexts()).map(s => s.split('\n')[0]);
    let pick;
    for (const want of order) {
      for (const n of names) {
        if (
          n.startsWith(want) &&
          (await button(pg, n)
            .isEnabled()
            .catch(() => false))
        ) {
          pick = n;
          break;
        }
      }
      if (pick) {
        break;
      }
    }
    if (!pick) {
      return seen;
    }
    await button(pg, pick)
      .click({ timeout: 3000 })
      .catch(() => undefined);
    await pg.waitForTimeout(2000);
  }
  return seen;
};

const genPhrase = (n = 24) => {
  const root = path.resolve(__dirname, '../../../..');
  const dir = fs
    .readdirSync(path.join(root, 'node_modules/.pnpm'))
    .find(d => /^@scure\+bip39@/.test(d));
  const b = require(path.join(root, 'node_modules/.pnpm', dir, 'node_modules/@scure/bip39'));
  const { wordlist } = require(
    path.join(root, 'node_modules/.pnpm', dir, 'node_modules/@scure/bip39/wordlists/english.js'),
  );
  return b.generateMnemonic(wordlist, n === 12 ? 128 : 256);
};

// relative luminance contrast of each text node's colour against its painted background
const contrastScan = pg =>
  pg.evaluate(() => {
    const rgb = s => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => {
      const f = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = el => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3] > 0.5)) {
          return c.slice(0, 3);
        }
      }
      return rgb(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    };
    const bad = [];
    let n = 0;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const el = t.parentElement;
      if (!t.textContent.trim() || !el || !el.getClientRects().length) {
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity === 0 || el.closest('[aria-hidden=true]')) {
        continue;
      }
      n++;
      const a = lum(rgb(cs.color).slice(0, 3)),
        b = lum(bgOf(el));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 2) {
        bad.push(`${t.textContent.trim().slice(0, 30)} (${ratio.toFixed(2)})`);
      }
    }
    const bg = rgb(getComputedStyle(document.body).backgroundColor);
    return { n, bad, bodyBg: bg, white: bg.slice(0, 3).every(c => c > 245) };
  });

module.exports = {
  CHROME,
  E,
  sleep,
  PASSWORD,
  launch,
  text,
  flat,
  clickText,
  button,
  toggle,
  heading,
  finishOnboarding,
  importSeed,
  createWallet,
  genPhrase,
  walkButtons,
  contrastScan,
};
