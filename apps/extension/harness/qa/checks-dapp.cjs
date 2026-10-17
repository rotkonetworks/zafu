// sites and identity: a1-a3, against a local test dapp on http://localhost
const L = require('./lib.cjs');
const { startDapp, dappSign } = require('./checks-install.cjs');

const withDapp = async (c, body) => {
  const z = await L.launch(c.dist);
  const d = await startDapp();
  try {
    await L.importSeed(z, L.genPhrase(24));
    const page = await z.ctx.newPage();
    await page.goto(d.url);
    await page.waitForTimeout(1500);
    return await body(z, d, page);
  } finally {
    await z.close();
    d.server.close();
  }
};

module.exports = {
  a1: {
    title: 'site sign request shows the site in full',
    run: c =>
      withDapp(c, async (z, d, page) => {
        const res = dappSign(page, z.id);
        const w = await z.panel(/approval\/sign/, 20000);
        if (!w) {
          return { status: 'fail', note: `no sign approval opened for ${d.url}` };
        }
        await L.sleep(1500);
        await w.shot(`${c.dir}/approval.png`);
        const t = L.flat(await w.text());
        const origin = new URL(d.url).origin;
        const full = t.includes(origin) || t.includes(origin.replace('http://', ''));
        await L.sleep(3000);
        const pressed = await w.click('sign in');
        await L.sleep(2000);
        // signing asks for the password once more
        if (/enter password/.test(L.flat((await w.text()) ?? ''))) {
          await w.type('input[type=password]', z.password);
          await L.sleep(500);
          await w.click('sign');
        }
        await L.sleep(3000);
        await w.shot(`${c.dir}/after-press.png`);
        const afterText = L.flat((await w.text().catch(() => '')) ?? '');
        const r = await res;
        const signed = r && typeof r === 'object' && r.success === true;
        return {
          status: full && signed ? 'pass' : 'fail',
          note: `zafu_sign from ${origin}, approval in the side panel (${w.url.replace(/^chrome-extension:\/\/[a-z]+\//, '')}): says "${t.slice(0, 140)}"; full origin shown: ${full}; pressed "sign in": ${pressed}, panel then "${afterText.slice(0, 80)}"; the page got ${JSON.stringify(r).slice(0, 100)} (${c.dir}/approval.png)`,
        };
      }),
  },

  a2: {
    title: 'passkey create and sign-in, virtual authenticator as the fallback',
    run: c =>
      withDapp(c, async (z, d, page) => {
        // the platform side: a CDP virtual authenticator, so a refusal would still have somewhere to go
        const cdp = await z.ctx.newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
          },
        });
        const create = page.evaluate(async () => {
          try {
            const cred = await navigator.credentials.create({
              publicKey: {
                rp: { id: 'localhost', name: 'qa dapp' },
                user: { id: new Uint8Array([1, 2, 3, 4]), name: 'qa', displayName: 'qa' },
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
              },
            });
            return { id: cred.id, type: cred.type };
          } catch (e) {
            return { error: String(e) };
          }
        });
        // a site's first passkey ask is its permission request
        const cap = await z.panel(/approval\/capability/, 15000);
        let capText = '';
        if (cap) {
          await L.sleep(1500);
          capText = L.flat(await cap.text());
          await cap.shot(`${c.dir}/capability.png`);
          await L.sleep(3000);
          (await cap.click('sign in')) ||
            (await cap.click('allow')) ||
            (await cap.click('approve'));
        }
        const w = await z.panel(/passkey-approve/, 20000);
        let wt = '';
        if (w) {
          await L.sleep(1500);
          wt = L.flat(await w.text());
          await w.shot(`${c.dir}/create.png`);
          await L.sleep(3000);
          await w.click('create passkey');
        }
        const created = await create;
        const fromPlatform = (await cdp.send('WebAuthn.getCredentials', { authenticatorId }))
          .credentials.length;
        const get = page.evaluate(async id => {
          try {
            const a = await navigator.credentials.get({
              publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rpId: 'localhost',
                allowCredentials: id ? [] : [],
              },
            });
            return { id: a.id, signed: a.response.signature.byteLength > 0 };
          } catch (e) {
            return { error: String(e) };
          }
        }, created.id);
        await L.sleep(2000);
        const w2 = await z.panel(/passkey-approve/, 20000);
        if (w2) {
          await L.sleep(1500);
          await w2.shot(`${c.dir}/sign-in.png`);
          await L.sleep(3000);
          await w2.click('sign in');
        }
        const got = await get;
        const list = L.flat(await L.text(await z.open('/identity/passwords', 'popup.html', 2000)));
        const ok = !!w && created.id && got.id === created.id && got.signed && fromPlatform === 0;
        return {
          status: ok ? 'pass' : 'fail',
          note: `create on ${d.url}: permission "${capText.slice(0, 60)}"; zafu asked "${wt.slice(0, 80)}"; page got ${JSON.stringify(created).slice(0, 60)}; virtual (platform) authenticator holds ${fromPlatform} credential(s); sign-in returned ${JSON.stringify(got).slice(0, 70)}; passkeys screen "${list.slice(list.indexOf('passkeys'), list.indexOf('passkeys') + 60)}" (${c.dir}/create.png, sign-in.png)`,
        };
      }),
  },

  a3: {
    title: 'keplr compat toggle',
    run: c =>
      withDapp(c, async (z, d, page) => {
        const has = async () => {
          await page.reload();
          await page.waitForTimeout(2000);
          return page.evaluate(() => typeof window.keplr);
        };
        const off0 = await has();
        await z.set({ enabledNetworks: ['zcash', 'penumbra'] });
        const st = await z.open('/settings/networks/penumbra', 'popup.html', 2000);
        await st
          .getByRole('button', { name: /^ibc chains/ })
          .first()
          .click();
        await st.waitForTimeout(800);
        const on = await L.toggle(st, 'act as keplr', true);
        await c.shot(st, 'toggle');
        const on1 = await has();
        const enable = page.evaluate(() =>
          Promise.race([
            window.keplr.enable('noble-1').then(
              () => 'enabled',
              e => String(e),
            ),
            new Promise(r => setTimeout(() => r('pending'), 20000)),
          ]),
        );
        const w = await z.panel(/approval\/keplr/, 15000);
        const wt = w ? L.flat(await w.text()) : '';
        if (w) {
          await w.shot(`${c.dir}/approval.png`);
          (await w.click('no, thank you')) || (await w.click('not now'));
        }
        const r = await enable;
        await L.toggle(st, 'act as keplr', false);
        const off1 = await has();
        const ok = off0 === 'undefined' && on && on1 === 'object' && !!w && off1 === 'undefined';
        return {
          status: ok ? 'pass' : 'fail',
          note: `window.keplr default: ${off0}; "act as keplr" on: ${on1}, keplr.enable('noble-1') opened ${w ? `the keplr approval "${wt.slice(0, 60)}"` : 'nothing'} -> declined -> ${JSON.stringify(r)}; off again: ${off1} (${c.dir}/toggle.png, approval.png)`,
        };
      }),
  },
};
