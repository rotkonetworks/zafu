/**
 * Real-Chromium smoke for the passkey consent flow (apps/extension/dist loaded
 * unpacked). Two cases:
 *
 *  LOCKED  - a sealed wallet must open the unlock surface and MUST NOT show the
 *            consent screen (approving a consent screen that cannot mint is the
 *            reported bug: the user approves, the mint throws, and the site is
 *            silently rerouted to the platform authenticator).
 *  UNLOCKED- with a session key but a vault that cannot be decrypted (the
 *            "wallet locked mid-flight" condition), approving must surface an
 *            honest NotAllowedError to the page - NOT a platform credential,
 *            and not a hang. A virtual authenticator is installed so that a
 *            silent fallback is observable as a *successful* credential.
 *
 * usage: node smoke.mjs [distDir]
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIST = process.argv[2] || '/steam/rotko/zafu/apps/extension/dist';
const PORT = 8099;
const PAGE = `http://localhost:${PORT}/`;

const HTML = `<!doctype html><meta charset="utf-8"><title>passkey smoke</title>
<body><h1>passkey smoke</h1>
<script>
window.createPasskey = () => navigator.credentials.create({ publicKey: {
  rp: { id: 'localhost', name: 'Smoke' },
  challenge: new Uint8Array([1, 2, 3, 4]),
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
  user: { id: new Uint8Array([9]), name: 'smoke', displayName: 'Smoke' },
} });
</script>`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
};

const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(HTML);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const profile = mkdtempSync(path.join(tmpdir(), 'zafu-passkey-smoke-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  viewport: { width: 1280, height: 900 },
});

/** every extension window the worker opened (chrome.windows.create shows up as a page) */
const popups = [];
ctx.on('page', p => {
  popups.push(p.url());
  console.log('  page opened:', p.url());
  // chrome.windows.create surfaces the page before it navigates to the hash
  // route, so track the URL after every navigation too.
  p.on('framenavigated', f => {
    if (f === p.mainFrame()) {
      popups.push(p.url());
      console.log('  page navigated:', p.url());
    }
  });
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  }
  const extId = new URL(sw.url()).host;
  const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  console.log(`extension ${extId} v${version} loaded from ${DIST}`);

  const page = await ctx.newPage();
  await page.goto(PAGE);

  // a virtual authenticator: with it, a fallback to the platform authenticator
  // *succeeds*, so "the page got a credential" is unambiguous evidence that
  // zafu did not handle the request itself.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const attemptCreate = () =>
    page.evaluate(async () => {
      try {
        const cred = await window.createPasskey();
        return { ok: true, id: cred?.id, source: cred?.authenticatorAttachment ?? 'unknown' };
      } catch (e) {
        return { ok: false, name: e?.name, message: e?.message };
      }
    });

  // ── LOCKED ──
  popups.length = 0;
  const locked = await attemptCreate();
  await page.waitForTimeout(2500);
  popups.push(...ctx.pages().map(p => p.url()));
  console.log('  locked create ->', JSON.stringify(locked));
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });
  console.log('  popups after locked create:', JSON.stringify(popups));
  check(
    'locked: no consent screen is offered',
    !popups.some(u => u.includes('passkey-approve')),
    JSON.stringify(popups),
  );
  check(
    'locked: the unlock surface opens instead',
    popups.some(u => u.includes('/login')),
    JSON.stringify(popups),
  );

  // close the login surface so the next case starts clean
  for (const p of ctx.pages()) {
    if (p.url().includes('/login')) {
      await p.close().catch(() => {});
    }
  }

  // ── UNLOCKED, vault cannot be decrypted ──
  const seeded = await sw.evaluate(async () => {
    await chrome.storage.local.set({
      vaults: [
        {
          id: 'vault-smoke',
          type: 'mnemonic',
          name: 'smoke',
          createdAt: Date.now(),
          encryptedData: 'not-a-real-ciphertext',
          salt: '',
          insensitive: {},
        },
      ],
      selectedVaultId: 'vault-smoke',
    });
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...raw))
      .split('+')
      .join('-')
      .split('/')
      .join('_')
      .split('=')
      .join('');
    await chrome.storage.session.set({
      passwordKey: {
        _inner: { kty: 'oct', k: b64, alg: 'A256GCM', ext: true, key_ops: ['encrypt', 'decrypt'] },
      },
    });
    return {
      vaults: (await chrome.storage.local.get('vaults')).vaults?.length,
      selected: (await chrome.storage.local.get('selectedVaultId')).selectedVaultId,
      unlocked: Boolean((await chrome.storage.session.get('passwordKey')).passwordKey),
    };
  });
  console.log('  seeded:', JSON.stringify(seeded));

  popups.length = 0;
  const pending = attemptCreate();
  let consent;
  for (let i = 0; i < 40 && !consent; i++) {
    consent = ctx.pages().find(p => p.url().includes('passkey-approve'));
    if (!consent) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  if (!consent) {
    check('unlocked: the consent screen opens', false, JSON.stringify(popups));
    console.log('  result:', JSON.stringify(await pending));
  } else {
    check('unlocked: the consent screen opens', true, consent.url());
    await consent.bringToFront();
    const closedAt = new Promise(r => consent.once('close', r));
    await consent.getByRole('button', { name: 'approve' }).click();
    await closedAt;
    console.log('  consent window closed after approve');
    const res = await pending;
    console.log('  unlocked create ->', JSON.stringify(res));
    check(
      'unlocked+failing vault: the page gets an honest error, not a platform credential',
      res.ok === false && res.name === 'NotAllowedError',
      JSON.stringify(res),
    );
    check(
      'unlocked+failing vault: the error names zafu (no silent platform fallback)',
      typeof res.message === 'string' && res.message.includes('zafu'),
      JSON.stringify(res.message),
    );
  }
} finally {
  await ctx.close().catch(() => {});
  server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
