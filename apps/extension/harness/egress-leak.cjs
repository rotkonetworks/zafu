// usage (repo root, after a build): node apps/extension/harness/egress-leak.cjs <dist> <out> [--state a,b] [--runs 2]
// Records every request the browser makes for zafu (CDP Network on every target, a net-log, and a
// logging CONNECT proxy that can also cut nym off) across settings states, and checks each one
// against the policy's own answer (egress-expect.ts -> compileEgress/decideEgress/nymPlan).
const path = require('path'),
  fs = require('fs'),
  os = require('os'),
  http = require('http'),
  net = require('net');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const EXT = path.join(ROOT, 'apps/extension');
const pwDir = fs
  .readdirSync(path.join(ROOT, 'node_modules/.pnpm'))
  .find(d => /^playwright@/.test(d));
const pw = require(path.join(ROOT, 'node_modules/.pnpm', pwDir, 'node_modules/playwright'));

// the public bip39 test vector: no funds of ours, never used for anything real
const PHRASE = 'abandon '.repeat(23) + 'art';
const PASSWORD = 'harness-password-1';
const IDLE_MS = +(process.env.IDLE_MS ?? 120_000);
const SEND_INTENT = /^\/(send|swap|lp)/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const [dist, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

// ---- the proxy: every connection the browser opens, realm-agnostic; `cut` refuses some
const startProxy = () => {
  const log = [];
  const open = new Set();
  let cut = () => false;
  const server = http.createServer((req, res) => {
    // plain http through the proxy (absolute-uri)
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const refused = cut(u.hostname, u.port || '80');
    log.push({
      t: Date.now(),
      kind: 'http',
      host: u.hostname,
      port: u.port || '80',
      url: req.url,
      refused,
    });
    if (refused) {
      res.writeHead(403).end();
      return;
    }
    const up = http.request(req.url, { method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    const [host, port] = req.url.split(/:(?=\d+$)/);
    const refused = cut(host, port);
    log.push({ t: Date.now(), kind: 'connect', host, port, refused });
    if (refused) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    const up = net.connect(+port, host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return new Promise(r =>
    server.listen(0, '127.0.0.1', () =>
      r({
        server,
        log,
        port: server.address().port,
        setCut: f => (cut = f),
        // drop every tunnel already open, as a lost network would
        drop: () => open.forEach(s => s.destroy()),
      }),
    ),
  );
};

// a web page the content scripts inject into: it must cause no request but its own load
const startPage = () =>
  new Promise(r => {
    const s = http.createServer((_, res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>blank</title><p>blank'),
    );
    s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port }));
  });

// ---- CDP on every target, flattened, recursing into dedicated workers
const startCdp = async profile => {
  let line;
  for (let i = 0; i < 100 && !line; i++) {
    try {
      line = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8');
    } catch {
      await sleep(100);
    }
  }
  const [port, wsPath] = line.trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise(r => {
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId && { sessionId }) }));
    });
  const targets = new Map(); // sessionId -> targetInfo
  const reqs = new Map(); // sessionId:requestId -> record
  const records = [];
  const logs = [];
  const realmOf = ti => {
    const u = ti.url || '';
    if (ti.type === 'service_worker') {
      return 'service-worker';
    }
    if (/nym-worker/.test(u) || ti.title === 'zafu-nym') {
      return 'nym';
    }
    if (ti.type === 'worker' || ti.type === 'shared_worker') {
      return 'worker';
    }
    if (/^chrome-extension:/.test(u)) {
      return /offscreen/.test(u)
        ? 'offscreen'
        : /\/(popup|sidepanel)\.html/.test(u)
          ? 'popup'
          : 'page';
    }
    return 'content-script';
  };
  const attach = async (sessionId, ti) => {
    targets.set(sessionId, ti);
    await send('Network.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      pending.get(m.id)?.(m.result ?? m);
      pending.delete(m.id);
      return;
    }
    const p = m.params ?? {};
    const ti = targets.get(m.sessionId);
    if (m.method === 'Target.attachedToTarget') {
      void attach(p.sessionId, p.targetInfo);
      return;
    }
    if (m.method === 'Target.targetInfoChanged') {
      for (const [s, t] of targets) {
        if (t.targetId === p.targetInfo.targetId) {
          targets.set(s, p.targetInfo);
        }
      }
      return;
    }
    if (!ti) {
      return;
    }
    const key = `${m.sessionId}:${p.requestId}`;
    if (m.method === 'Network.requestWillBeSent') {
      const r = {
        t: Date.now(),
        via: 'cdp',
        realm: realmOf(ti),
        target: ti.url,
        url: p.request.url,
        method: p.request.method,
        headers: p.request.headers,
        postData: p.request.postData,
        initiator: p.initiator,
        type: p.type,
      };
      reqs.set(key, r);
      records.push(r);
    } else if (m.method === 'Network.requestWillBeSentExtraInfo') {
      const r = reqs.get(key);
      if (r) {
        r.wireHeaders = p.headers;
      } else {
        reqs.set(key, { wireHeaders: p.headers });
      }
    } else if (m.method === 'Network.webSocketCreated') {
      const r = {
        t: Date.now(),
        via: 'cdp',
        realm: realmOf(ti),
        target: ti.url,
        url: p.url,
        method: 'WS',
        initiator: p.initiator,
        type: 'WebSocket',
      };
      reqs.set(key, r);
      records.push(r);
    } else if (m.method === 'Network.webSocketWillSendHandshakeRequest') {
      const r = reqs.get(key);
      if (r) {
        r.wireHeaders = p.request.headers;
      }
    } else if (m.method === 'Network.responseReceived') {
      const r = reqs.get(key);
      if (r) {
        r.status = p.response.status;
      }
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push({
        t: Date.now(),
        realm: realmOf(ti),
        target: ti.url,
        text: p.args.map(a => a.value ?? a.description ?? '').join(' '),
      });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const ed = p.exceptionDetails;
      logs.push({
        t: Date.now(),
        realm: realmOf(ti),
        target: ti.url,
        text: 'EXC ' + (ed.exception?.description ?? ed.text),
      });
    } else if (m.method === 'Network.loadingFailed') {
      const r = reqs.get(key);
      if (r) {
        r.failed = p.errorText;
      }
    }
  };
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const { targetInfos = [] } = await send('Target.getTargets');
  for (const t of targetInfos) {
    if (!t.attached || t.type !== 'browser') {
      await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    }
  }
  return { records, logs, send, sessions: () => [...targets.keys()], close: () => ws.close() };
};

// ---- the net-log: what left the network stack, whoever asked
const readNetLog = file => {
  let text = fs.readFileSync(file, 'utf8').trim();
  if (!text.endsWith('}')) {
    text = text.replace(/,\s*$/, '') + ']}';
  }
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    try {
      log = JSON.parse(text.replace(/,?\s*\{[^{}]*$/, '') + ']}');
    } catch {
      return [];
    }
  }
  const byId = {};
  for (const e of log.events ?? []) {
    const p = e.params ?? {};
    if (!p.url && !p.initiator && !p.host) {
      continue;
    }
    const s = (byId[e.source.id] ??= {});
    if (p.url && /^(https?|wss?):/.test(p.url)) {
      s.url ??= p.url;
    }
    if (p.initiator) {
      s.initiator ??= p.initiator;
    }
    if (p.method) {
      s.method ??= p.method;
    }
  }
  return Object.values(byId)
    .filter(s => s.url)
    .map(s => ({ via: 'netlog', ...s }));
};

// ---- the policy's answer, from the policy's own code
const oracle = (inputs, unlocked, requests) =>
  JSON.parse(
    execFileSync(
      path.join(ROOT, 'node_modules/.bin/tsx'),
      [path.join(__dirname, 'egress-expect.ts')],
      {
        cwd: EXT,
        input: JSON.stringify({ inputs, unlocked, requests }),
        maxBuffer: 1 << 28,
      },
    ).toString(),
  );

// ---- the extension
const launch = async (dist, proxyPort, netlog) => {
  const ext = path.resolve(dist),
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zafu-leak-'));
  const ctx = await pw.chromium.launchPersistentContext(profile, {
    executablePath: '/usr/bin/chromium',
    headless: true,
    viewport: { width: 400, height: 628 },
    args: [
      '--headless=new',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--remote-debugging-port=0',
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      `--log-net-log=${netlog}`,
      '--net-log-capture-mode=Default',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
    ],
  });
  const cdp = await startCdp(profile);
  const sw0 =
    ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const id = new URL(sw0.url()).host;
  const sw = () => ctx.serviceWorkers().find(w => w.url().includes(id)) ?? sw0;
  return { ctx, cdp, id, sw, profile };
};

const walkImport = async p => {
  await p.goto(p.url().replace(/#.*/, '#/welcome/import'));
  await p.waitForTimeout(800);
  await p.locator('textarea').first().fill(PHRASE);
  await p.locator('button[type=submit]').click();
  await p.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) {
    const h = (
      await p
        .locator('h1')
        .first()
        .innerText()
        .catch(() => '')
    ).trim();
    if (/set a password/.test(h)) {
      const pws = p.locator('input[type=password]');
      for (let j = 0; j < (await pws.count()); j++) {
        await pws.nth(j).fill(PASSWORD);
      }
      await p.locator('button[type=submit]').click();
    } else if (/make it yours/.test(h)) {
      await p.getByRole('button', { name: 'keep defaults' }).click();
    } else if (/wallet ready/.test(h)) {
      return;
    } else {
      await p.locator('button.h-14').first().click();
    }
    await p.waitForTimeout(2000);
  }
  throw new Error('onboarding did not reach "wallet ready"');
};

const routes = (() => {
  const src = fs.readFileSync(path.join(EXT, 'src/routes/popup/paths.ts'), 'utf8');
  const SKIP =
    /approval|login|welcome|forgot-password|cosmos-sign|frost-approve|passkey-approve|:|remove-wallet/;
  return [...new Set([...src.matchAll(/= '(\/[^']*)'/g)].map(m => m[1]))].filter(
    r => !SKIP.test(r),
  );
})();

// the whole local store: compileEgress reads only its own keys from it
const snapInputs = async sw =>
  sw()
    .evaluate(() => chrome.storage.local.get(null))
    .catch(() => ({}));

// merge `{ optIns, destinations }` into the stored ledger, as the settings screens do
const egressSet = (sw, patch) =>
  sw().evaluate(async patch => {
    const r = await chrome.storage.local.get('netEgress');
    const ne = r.netEgress ?? { destinations: {}, optIns: {} };
    ne.optIns = { ...ne.optIns, ...patch.optIns };
    ne.destinations = { ...ne.destinations, ...patch.destinations };
    await chrome.storage.local.set({ netEgress: ne });
  }, patch);
const lock = sw =>
  sw().evaluate(() => chrome.storage.session.remove(['passwordKey', 'identityKeys']));

// ---- the states: settings, then what is done in them
const NYM_CUT = (host, port) => port === '9001' || /(^|\.)nymtech\.net$/.test(host);
const STATES = {
  default: { idle: ['unlocked', 'locked'], probes: true, page: true },
  locked: { lockFirst: true },
  page: { page: true, walk: false },
  'master-off': { set: { optIns: { nym: 'blocked' } }, probes: true },
  'zcash-nym-off': { set: { optIns: { 'nym:zcash': 'blocked' } }, probes: true },
  'penumbra-nym-off': { networks: ['zcash', 'penumbra'], probes: 'penumbra' },
  'penumbra-nym-on': {
    networks: ['zcash', 'penumbra'],
    set: { optIns: { 'nym:penumbra': 'allowed' } },
    probes: 'penumbra',
  },
  'keep-ready-off': { set: { optIns: { 'nym-ready': 'blocked' } }, idle: ['unlocked'] },
  'host-blocked': {
    set: {
      destinations: {
        'zcash.rotko.net': {
          state: 'blocked',
          label: 'zcash light client',
          purposes: ['chain-rpc'],
          firstSeen: 0,
        },
      },
    },
  },
  'nym-broken': { cut: NYM_CUT, send: true, probes: true },
};

// synthetic requests of each nym class, from the popup's own guarded fetch. an empty
// grpc-web frame is no transaction: nothing is broadcast, whatever path it takes
const PROBES = {
  zcash: [
    'https://zcash.rotko.net/zidecar.v1.Zidecar/SendTransaction',
    'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTransaction',
    'https://zcash.rotko.net/zidecar.v1.Zidecar/GetAddressUtxos',
  ],
  penumbra: [
    'https://penumbra.rotko.net/penumbra.util.tendermint_proxy.v1.TendermintProxyService/BroadcastTxSync',
    'https://penumbra.rotko.net/penumbra.util.tendermint_proxy.v1.TendermintProxyService/GetTx',
  ],
};
const probe = (p, urls) =>
  p.evaluate(
    urls =>
      Promise.all(
        urls.map(u =>
          Promise.race([
            fetch(u, {
              method: 'POST',
              headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
              body: new Uint8Array(5),
            }).then(
              r => r.status,
              e => String(e.message),
            ),
            new Promise(r => setTimeout(() => r('pending'), 90000)),
          ]),
        ),
      ),
    urls,
  );

const runState = async (name, spec, runDir) => {
  const proxy = await startProxy();
  proxy.setCut(spec.cut ?? (() => false));
  const pageSrv = spec.page ? await startPage() : undefined;
  const netlog = path.join(runDir, `${name}.netlog.json`);
  const { ctx, cdp, id, sw } = await launch(dist, proxy.port, netlog);
  const phases = [];
  let unlocked = false;
  const phase = async (pname, body) => {
    const prev = phases.at(-1);
    // the time between two phases is judged too, with the settings it had
    const now = await snapInputs(sw);
    if (prev) {
      phases.push({
        name: `after-${prev.name}`,
        start: prev.end,
        end: Date.now(),
        unlocked,
        inputs: now,
        inputsPrev: prev.inputsEnd,
        notes: [],
      });
    }
    const ph = {
      name: pname,
      start: Date.now(),
      unlocked,
      inputs: now,
      intentAt: undefined,
      notes: [],
    };
    phases.push(ph);
    await body(ph);
    ph.end = Date.now();
    ph.inputsEnd = await snapInputs(sw);
    ph.unlockedEnd = unlocked;
  };
  try {
    await phase('import', async ph => {
      const s = await ctx.newPage();
      await s.goto(`chrome-extension://${id}/page.html#/welcome`);
      await s.waitForTimeout(800);
      // a fresh profile's storage is stamped by the first page: a choice written earlier is migrated away
      if (spec.set) {
        await egressSet(sw, spec.set);
      }
      await walkImport(s);
      unlocked = true;
      await s.close();
      ph.unlocked = true;
    });
    if (spec.networks) {
      await sw().evaluate(n => chrome.storage.local.set({ enabledNetworks: n }), spec.networks);
    }
    if (spec.set) {
      await egressSet(sw, spec.set);
    }
    if (spec.lockFirst) {
      await lock(sw);
      unlocked = false;
    }
    await sleep(1500);
    await phase('walk', async ph => {
      const pg = await ctx.newPage();
      for (const r of spec.walk === false ? [] : routes) {
        if (SEND_INTENT.test(r) && !ph.intentAt) {
          ph.intentAt = Date.now();
        }
        await pg.goto(`chrome-extension://${id}/popup.html#${r}`).catch(() => undefined);
        await pg.waitForTimeout(1500);
      }
      await pg.close();
    });
    if (spec.send) {
      await phase('send', async ph => {
        const pg = await ctx.newPage();
        await pg.goto(`chrome-extension://${id}/popup.html#/receive`);
        await pg.waitForTimeout(2500);
        const addr = ((await pg.locator('body').innerText()).match(/\bu1[0-9a-z]{60,}/) ?? [])[0];
        ph.intentAt = Date.now();
        await pg.goto(`chrome-extension://${id}/popup.html#/send`);
        await pg.waitForTimeout(2500);
        const inputs = pg.locator('input:visible, textarea:visible');
        for (let i = 0; i < (await inputs.count()); i++) {
          const el = inputs.nth(i),
            mode = await el.getAttribute('inputmode');
          await el
            .fill(mode === 'decimal' || mode === 'numeric' ? '0.001' : (addr ?? ''))
            .catch(() => undefined);
        }
        await pg.waitForTimeout(1000);
        const primary = pg.getByRole('button', { name: /review|continue|next/i }).first();
        ph.notes.push(
          `send: address ${addr ? 'filled' : 'not found'}, review button ${(await primary.isEnabled().catch(() => false)) ? 'enabled' : 'disabled'}`,
        );
        await primary.click({ timeout: 3000 }).catch(() => undefined);
        await pg.waitForTimeout(3000);
        await pg.screenshot({ path: path.join(runDir, `${name}-send.png`) });
        ph.notes.push(
          'send screen: ' +
            (await pg.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300),
        );
        await pg.waitForTimeout(150_000 - 9000);
        await pg.close();
      });
    }
    if (spec.probes) {
      await phase('probes', async ph => {
        const pg = await ctx.newPage();
        await pg.goto(`chrome-extension://${id}/popup.html#/`);
        await pg.waitForTimeout(1500);
        ph.intentAt = Date.now();
        ph.notes.push(
          'probe results ' +
            JSON.stringify(await probe(pg, PROBES[spec.probes === true ? 'zcash' : spec.probes])),
        );
        await pg.close();
      });
    }
    if (pageSrv) {
      await phase('content-script', async ph => {
        const pg = await ctx.newPage();
        await pg.goto(`http://localhost:${pageSrv.port}/`);
        await pg.waitForTimeout(5000);
        // a clean result means something only if the scripts were there
        const injected = await pg.evaluate(() => ({
          penumbra: !!window[Symbol.for('penumbra')],
          zafu: !!window.zafu,
        }));
        ph.notes.push('content scripts injected ' + JSON.stringify(injected));
        await pg.close();
      });
    }
    for (const which of spec.idle ?? []) {
      if (which === 'locked') {
        await lock(sw);
        unlocked = false;
        await sleep(3000);
      }
      for (const p of ctx.pages()) {
        await p.close();
      }
      await sleep(5000);
      await phase(`idle-${which}`, () => sleep(IDLE_MS));
      if (which === 'unlocked' && spec.idle.includes('locked')) {
        const p = await ctx.newPage();
        await p.goto(`chrome-extension://${id}/popup.html#/`);
        await p.waitForTimeout(2000);
      }
    }
  } finally {
    const last = phases.at(-1);
    if (last?.end) {
      phases.push({
        name: `after-${last.name}`,
        start: last.end,
        end: Date.now(),
        unlocked,
        inputs: last.inputsEnd,
        notes: [],
      });
    }
    await ctx.close().catch(() => undefined);
    cdp.close();
    proxy.server.close();
    pageSrv?.server.close();
  }
  return { phases, cdp: cdp.records, proxy: proxy.log, netlog: readNetLog(netlog), id };
};

// ---- judging
const isNet = u => /^(https?|wss?):/.test(u) && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u);
const hostPort = u => {
  const x = new URL(u);
  return `${x.hostname}:${x.port || (/^(https|wss):/.test(u) ? '443' : '80')}`;
};
const OK_HEADERS =
  /^(accept|accept-encoding|accept-language|content-type|content-length|origin|user-agent|sec-.*|connection|host|pragma|cache-control|x-grpc-web|x-user-agent|grpc-timeout|te|upgrade|priority)$/i;
const phaseOf = (phases, t) =>
  phases.find(p => t >= p.start && t <= (p.end ?? Infinity)) ??
  (t >= phases.at(-1).start ? { name: 'teardown' } : undefined);

const judge = (name, res) => {
  const findings = [];
  const add = (code, r, why) =>
    findings.push({
      code,
      state: name,
      phase: r.phase,
      realm: r.realm ?? '?',
      via: r.via,
      method: r.method,
      url: r.url ?? `${r.host}:${r.port}`,
      why,
      initiator: r.initiator ? JSON.stringify(r.initiator).slice(0, 600) : undefined,
    });
  const wire = res.cdp.filter(r => isNet(r.url) && r.method !== 'OPTIONS');
  for (const r of wire) {
    r.phase = phaseOf(res.phases, r.t)?.name;
  }
  // the oracle, per phase, with that phase's own settings
  for (const ph of res.phases) {
    const mine = wire.filter(r => r.phase === ph.name);
    if (!mine.length) {
      continue;
    }
    const inputs = ph.name === 'import' ? ph.inputsEnd : ph.inputs;
    const o = oracle(
      inputs,
      ph.name === 'import' ? true : ph.unlocked,
      mine.map(r => ({ url: r.url.replace(/^ws/, 'http'), realm: r.realm })),
    );
    ph.plan = o.plan;
    mine.forEach((r, i) => (r.decision = o.decisions[i]));
    // between phases a setting just changed: a request the old settings allowed is a race, not a leak
    if (ph.inputsPrev) {
      const before = oracle(
        ph.inputsPrev,
        ph.unlocked,
        mine.map(r => ({ url: r.url.replace(/^ws/, 'http'), realm: r.realm })),
      );
      mine.forEach((r, i) => (r.decisionBefore = before.decisions[i]));
    }
  }
  for (const r of wire) {
    const d = r.decision,
      ph = res.phases.find(p => p.name === r.phase);
    if (!d) {
      continue;
    }
    if (!d.allow) {
      add(
        r.decisionBefore?.allow ? 'RACE' : 'DISALLOWED',
        r,
        `policy: ${d.reason} (${d.destination ?? 'no destination'})${r.decisionBefore?.allow ? ', allowed just before the change' : ''}`,
      );
    } else if (
      r.realm !== 'nym' &&
      (d.nym ||
        (d.nymBody && r.postData && d.nymBody.some(([p]) => new RegExp(p).test(r.postData))))
    ) {
      add('DIRECT-NYM', r, `class ${d.nym ?? 'body'} must go over nym, went direct`);
    }
    if (r.realm === 'nym' && ph) {
      if (ph.plan === 'down' && !ph.intentAt) {
        add('NYM-UNPLANNED', r, `nym plan is down in this phase`);
      } else if (
        ph.plan === 'leave' &&
        (!ph.intentAt || r.t < ph.intentAt) &&
        !/^idle/.test(ph.name)
      ) {
        add('NYM-NO-INTENT', r, 'on-demand nym, before any send intent');
      }
    }
    if (ph?.name === 'idle-locked') {
      add('IDLE-LOCKED', r, 'request while locked with every window closed');
    }
    if (ph?.name === 'idle-unlocked' && (r.realm !== 'nym' || ph.plan !== 'up')) {
      add('IDLE-UNLOCKED', r, `request while unlocked and closed (plan ${ph.plan})`);
    }
    if (r.realm === 'content-script') {
      add('CONTENT-SCRIPT', r, 'a web page realm reached the network');
    }
    const hdrs = r.wireHeaders ?? r.headers ?? {};
    const extra = Object.keys(hdrs).filter(
      h => !OK_HEADERS.test(h) && !h.startsWith(':') && String(hdrs[h]) !== '',
    );
    if (extra.length) {
      add('HEADERS', r, `headers ${extra.join(', ')}`);
    }
  }
  // the browser-level views: anything the hooks did not see, from the extension
  const seenUrls = new Set(wire.map(r => r.url));
  const seenHosts = new Set(wire.map(r => hostPort(r.url)));
  for (const n of res.netlog) {
    if (!isNet(n.url) || seenUrls.has(n.url)) {
      continue;
    }
    if (n.initiator && n.initiator.includes(res.id)) {
      add('UNATTRIBUTED', { ...n, phase: '?' }, 'net-log: extension-initiated, on no CDP target');
    }
  }
  for (const c of res.proxy) {
    c.phase = phaseOf(res.phases, c.t)?.name;
    const hp = `${c.host}:${c.port}`;
    if (/^(localhost|127\.0\.0\.1)$/.test(c.host)) {
      continue;
    }
    if (c.phase === 'idle-locked') {
      add(
        'IDLE-LOCKED',
        { ...c, via: 'proxy' },
        'connection while locked with every window closed',
      );
    }
    if (c.phase === 'idle-unlocked') {
      const ph = res.phases.find(p => p.name === 'idle-unlocked');
      const nymish = NYM_CUT(c.host, c.port);
      if (!nymish || ph.plan !== 'up') {
        add(
          'IDLE-UNLOCKED',
          { ...c, via: 'proxy' },
          `connection while unlocked and closed (plan ${ph.plan})`,
        );
      }
    }
    if (
      !seenHosts.has(hp) &&
      !res.netlog.some(
        n => isNet(n.url) && hostPort(n.url) === hp && n.initiator && !n.initiator.includes(res.id),
      )
    ) {
      add(
        'UNATTRIBUTED',
        { ...c, via: 'proxy' },
        'proxy: connection seen on no extension CDP target',
      );
    }
  }
  return { findings, wire };
};

const summarise = (name, res, wire) => {
  const by = {};
  for (const r of wire) {
    const k = `${r.phase}|${r.realm}|${hostPort(r.url)}|${r.decision?.allow ? (r.decision.nym ? 'allow+nym:' + r.decision.nym : 'allow') : 'deny'}`;
    by[k] = (by[k] ?? 0) + 1;
  }
  const proxyBy = {};
  for (const c of res.proxy) {
    const k = `${c.phase}|${c.host}:${c.port}${c.refused ? ' (cut)' : ''}`;
    proxyBy[k] = (proxyBy[k] ?? 0) + 1;
  }
  return {
    cdp: by,
    proxy: proxyBy,
    phases: res.phases.map(p => ({
      name: p.name,
      plan: p.plan,
      unlocked: p.unlocked,
      secs: Math.round((p.end - p.start) / 1000),
      notes: p.notes,
    })),
  };
};

module.exports = { startProxy, startPage, startCdp, readNetLog, oracle, isNet, hostPort, pw };
if (require.main !== module) {
  return;
}

(async () => {
  if (!dist || !out) {
    console.error('usage: egress-leak.cjs <dist> <out> [--state a,b] [--runs N]');
    process.exit(2);
  }
  const names = (flag('--state') ?? Object.keys(STATES).join(',')).split(',');
  const runs = +flag('--runs', '1');
  const all = {};
  for (let run = 1; run <= runs; run++) {
    const runDir = path.join(out, `run${run}`);
    fs.mkdirSync(runDir, { recursive: true });
    for (const name of names) {
      const t0 = Date.now();
      let res, j;
      try {
        res = await runState(name, STATES[name], runDir);
        j = judge(name, res);
      } catch (e) {
        console.log(`ERROR ${name} run${run}: ${e.message.split('\n')[0]}`);
        continue;
      }
      const sum = summarise(name, res, j.wire);
      fs.writeFileSync(
        path.join(runDir, `${name}.json`),
        JSON.stringify(
          {
            summary: sum,
            findings: j.findings,
            cdp: res.cdp,
            proxy: res.proxy,
            netlog: res.netlog,
          },
          null,
          1,
        ),
      );
      (all[name] ??= []).push(j.findings);
      const codes = {};
      for (const f of j.findings) {
        codes[f.code] = (codes[f.code] ?? 0) + 1;
      }
      console.log(
        `run${run} ${name} ${Math.round((Date.now() - t0) / 1000)}s requests=${j.wire.length} connects=${res.proxy.length} findings=${JSON.stringify(codes)}`,
      );
    }
  }
  // confirmed: the same (code, state, realm, host+path) in every run
  // an idle finding is any request at all, so it is confirmed by host, not by which call it was;
  // proxy rows carry no realm
  const keyOf = f => {
    let u = f.url.replace(/:443$/, '');
    try {
      const x = new URL(f.url);
      u = /^IDLE/.test(f.code) ? x.host : `${x.host}${x.pathname}`;
    } catch {}
    return `${f.code}|${f.state}|${/^IDLE/.test(f.code) ? f.via : f.realm}|${u}`;
  };
  const confirmed = {};
  for (const [name, perRun] of Object.entries(all)) {
    const sets = perRun.map(fs_ => new Map(fs_.map(f => [keyOf(f), f])));
    for (const [k, f] of sets[0]) {
      if (sets.every(s => s.has(k))) {
        confirmed[k] = {
          ...f,
          count: perRun.reduce((n, r) => n + r.filter(x => keyOf(x) === k).length, 0),
          runs: perRun.length,
        };
      }
    }
  }
  fs.writeFileSync(
    path.join(out, 'confirmed.json'),
    JSON.stringify(Object.values(confirmed), null, 1),
  );
  for (const f of Object.values(confirmed)) {
    console.log(
      `CONFIRMED ${f.code} ${f.state}/${f.phase} ${f.realm} ${f.via} ${f.method ?? ''} ${f.url} x${f.count} - ${f.why}`,
    );
  }
  process.exit(0);
})().catch(e => {
  console.error('FAIL', e.stack);
  process.exit(1);
});
